import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../schema"
import { ScheduleRunDAO } from "../schedule-run-dao"
import { TERMINAL_EXECUTION_STATUSES } from "@octopus/shared"

/**
 * 票02 (ADR-0021) — the one meter the concurrency cap is enforced against.
 *
 * `countActiveWork()` exists because "in flight" after v41 lives in two tables: a job's
 * current fire is a `schedule_executions` row, a task's current launch is an `executions`
 * row carrying `task_id`. The three cap consumers (engine claim loop, executor re-check,
 * composite fan-out pre-check) used to count only the first — correct while tasks also
 * lived there, wrong the moment task launches became execution rows.
 */

let db: Database.Database
let dao: ScheduleRunDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-active-work-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new ScheduleRunDAO(db)
  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
     VALUES ('ws-1','W1','xzf','/tmp/ws1','now','now')`,
  ).run()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

const now = () => new Date().toISOString()

function addSchedule(id: string, jobType: "workflow" | "agent" | "job"): void {
  db.prepare(
    `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
     VALUES (?, 'xzf', ?, '0 9 * * *', 'UTC', 1, ?, '{}', 'now', 'now')`,
  ).run(id, `S_${id}`, jobType)
}

function addFire(id: string, scheduleId: string, status: string): void {
  db.prepare(
    `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at)
     VALUES (?, ?, ?, 'scheduled', ?, '+00:00', 'UTC', 'now')`,
  ).run(id, scheduleId, status, now())
}

function addExec(id: string, status: string, taskId: string | null, parentId = "0"): void {
  db.prepare(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, task_id, parent_id, created_at, updated_at)
     VALUES (?, 'ws-1', 'wf/x.yaml', 'x', ?, 'xzf', ?, ?, 'now', 'now')`,
  ).run(id, status, taskId, parentId)
}

describe("countActiveWork — spans both kinds of in-flight work", () => {
  it("counts a live workflow-job fire", () => {
    addSchedule("sch-wf", "workflow")
    addFire("f1", "sch-wf", "running")
    expect(dao.countActiveWork()).toBe(1)
  })

  it("counts a live task launch even with no schedule row at all", () => {
    addExec("e1", "running", "task-1")
    expect(dao.countActiveWork()).toBe(1)
  })

  it("adds the two tables rather than picking one", () => {
    addSchedule("sch-wf", "workflow")
    addFire("f1", "sch-wf", "triggered")
    addExec("e1", "running", "task-1")
    expect(dao.countActiveWork()).toBe(2)
  })

  it("an ARMED (pending) launch holds no slot — that is the queue, not the work", () => {
    // The other axis, ux_exec_task_active, DOES count pending (identity). Conflating the
    // two makes the gate self-blocking: three armed tasks would read as "cap reached" and
    // freeze every launch behind rows that are waiting for this meter to free up.
    addExec("e-p1", "pending", "task-p1")
    addExec("e-p2", "pending", "task-p2")
    expect(dao.countActiveWork()).toBe(0)
    addExec("e-run", "running", "task-run")
    expect(dao.countActiveWork()).toBe(1)
  })

  it("ignores finished work on both sides", () => {
    addSchedule("sch-wf", "workflow")
    addFire("f-done", "sch-wf", "completed")
    addFire("f-fail", "sch-wf", "failed")
    addExec("e-done", "completed", "task-1")
    addExec("e-abort", "aborted", "task-2")
    addExec("e-free", "running", null)
    expect(dao.countActiveWork()).toBe(0)
  })

  it("a schedule can only have ONE live fire, so the meter is per-job by construction", () => {
    // idx_sched_execs_unique_active (partial UNIQUE on schedule_id WHERE
    // status IN ('triggered','running')) makes the "two live fires of one schedule"
    // state unrepresentable. The DISTINCT in countActiveWork is therefore belt-and-braces,
    // and one busy job is one unit of work — never two.
    addSchedule("sch-wf", "workflow")
    addFire("f1", "sch-wf", "running")
    expect(dao.countActiveWork()).toBe(1)
    expect(() => addFire("f2", "sch-wf", "triggered")).toThrow(/UNIQUE/)
    expect(dao.countActiveWork()).toBe(1)
  })

  it("does NOT count the housekeeping jobs' own fires", () => {
    // The built-in task-lifecycle job runs every minute by design. If its fire counted,
    // it would permanently occupy 1 of the 3 real slots.
    addSchedule("builtin-task-lifecycle", "job")
    addFire("f-job", "builtin-task-lifecycle", "running")
    expect(dao.countActiveWork()).toBe(0)
  })

  it("still counts a real job that happens to be scheduled alongside a housekeeping fire", () => {
    addSchedule("builtin-task-lifecycle", "job")
    addFire("f-job", "builtin-task-lifecycle", "running")
    addSchedule("sch-daily", "workflow")
    addFire("f-wf", "sch-daily", "running")
    expect(dao.countActiveWork()).toBe(1)
  })

  it("counts a composite's running CHILDREN — each holds a workspace and an engine", () => {
    // Before v41 a child was its own schedule row, so the meter counted it; counting only
    // roots would have silently raised a composite task's real concurrency. The LATCH is
    // the roots-only one (a composite may run several children of one task at once) —
    // this axis is compute slots, so it is not.
    addExec("root", "running", "task-c")
    addExec("kid1", "running", "task-c", "root")
    addExec("kid2", "pending", "task-c", "root")
    expect(dao.countActiveWork()).toBe(2)
  })

  it("treats every alive status as work, including approval and interaction parks", () => {
    // Every status that is neither terminal nor queued counts — fail-closed, so a status
    // added later still holds a slot. 'pending' is the single deliberate subtraction (the
    // armed queue), see the test above.
    for (const alive of ["running", "paused", "pending_approval", "pending_resume"]) {
      addExec(`e-${alive}`, alive, `task-${alive}`)
    }
    expect(dao.countActiveWork()).toBe(4)
  })

  it("honors both exclusions, since a caller is always itself in flight", () => {
    // A claimer must not count itself: the engine has already flipped its own row to
    // claimed/running before it re-checks the cap.
    addSchedule("sch-a", "workflow")
    addSchedule("sch-b", "agent")
    addFire("f-a", "sch-a", "running")
    addFire("f-b", "sch-b", "running")
    addExec("e1", "running", "task-1")
    expect(dao.countActiveWork()).toBe(3)
    expect(dao.countActiveWork({ excludeFireId: "f-a" })).toBe(2)
    expect(dao.countActiveWork({ excludeTaskExecutionId: "e1" })).toBe(2)
    expect(dao.countActiveWork({ excludeFireId: "f-a", excludeTaskExecutionId: "e1" })).toBe(1)
  })
})

/**
 * The two consumers of `TERMINAL_EXECUTION_STATUSES` are this DAO and the SQL-side
 * `ux_exec_task_active` partial index. SQL can't import a constant, so drift is possible
 * — and drift means either double-launching a task (index too loose) or wedging it
 * forever (index too tight). This is the only guard, so it is written as an equality on
 * the index's own DDL text rather than a re-typed list.
 */
describe("TERMINAL_EXECUTION_STATUSES agrees with the DB latch", () => {
  it("the single-source list is exactly the ExecutionStatus set minus the alive ones", () => {
    for (const s of ["completed", "completed_with_failures", "failed", "cancelled", "skipped", "rejected"]) {
      expect(TERMINAL_EXECUTION_STATUSES).toContain(s)
    }
    for (const alive of ["pending", "running", "paused", "pending_approval", "pending_resume"]) {
      expect(TERMINAL_EXECUTION_STATUSES).not.toContain(alive)
    }
  })

  it("ux_exec_task_active's DDL lists exactly this set, nothing more or less", () => {
    const ddl = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_exec_task_active'",
    ).get() as { sql: string }).sql
    const inSql = [...ddl.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
      // The predicate also names the root marker '0' — not a status.
      .filter(v => v !== "0")
    expect(inSql.sort()).toEqual([...TERMINAL_EXECUTION_STATUSES].sort())
  })

  it("the latch and the meter agree on a status that is in neither list", () => {
    // A newly introduced status must HOLD the slot in both places (fail-closed).
    addExec("e-weird", "waiting_on_something_new", "task-weird")
    expect(dao.countActiveWork()).toBe(1)
    expect(() => addExec("e-weird2", "pending", "task-weird")).toThrow(/UNIQUE/)
  })
})
