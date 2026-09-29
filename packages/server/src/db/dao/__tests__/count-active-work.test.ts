import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { describePg, setupPgSchema, type PgFixture } from "../../pg/__tests__/dao-fixture"
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
 *
 * P1 B5 票4：ScheduleRunDAO 已迁 BasePgDAO（B5 票1）—— 整簇表（schedules/
 * schedule_executions/executions/workspaces）落在 PG 随机测试库，latch 对拍改读
 * pg_indexes 的 indexdef。SQLite 模式下 describePg 门控 skip（计数不减）。
 */

let pg: PgFixture
let dao: ScheduleRunDAO

beforeEach(async () => {
  pg = await setupPgSchema()
  dao = new ScheduleRunDAO(pg.sql)
  await pg.sql.unsafe(
    `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
     VALUES ($1,'W1','xzf','/tmp/ws1',now(),now())`,
    ["ws-1"],
  )
})

afterEach(async () => {
  await pg.close()
})

const now = () => new Date().toISOString()

async function addSchedule(id: string, jobType: "workflow" | "agent" | "job"): Promise<void> {
  await pg.sql.unsafe(
    `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
     VALUES ($1, 'xzf', $2, '0 9 * * *', 'UTC', true, $3, '{}'::jsonb, now(), now())`,
    [id, `S_${id}`, jobType],
  )
}

async function addFire(id: string, scheduleId: string, status: string): Promise<void> {
  await pg.sql.unsafe(
    `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at)
     VALUES ($1, $2, $3, 'scheduled', $4, '+00:00', 'UTC', now())`,
    [id, scheduleId, status, now()],
  )
}

async function addExec(id: string, status: string, taskId: string | null, parentId = "0"): Promise<void> {
  await pg.sql.unsafe(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, task_id, parent_id, created_at, updated_at)
     VALUES ($1, 'ws-1', 'wf/x.yaml', 'x', $2, 'xzf', $3, $4, now(), now())`,
    [id, status, taskId, parentId],
  )
}

describePg("countActiveWork — spans both kinds of in-flight work", () => {
  it("counts a live workflow-job fire", async () => {
    await addSchedule("sch-wf", "workflow")
    await addFire("f1", "sch-wf", "running")
    expect(await dao.countActiveWork()).toBe(1)
  })

  it("counts a live task launch even with no schedule row at all", async () => {
    await addExec("e1", "running", "task-1")
    expect(await dao.countActiveWork()).toBe(1)
  })

  it("adds the two tables rather than picking one", async () => {
    await addSchedule("sch-wf", "workflow")
    await addFire("f1", "sch-wf", "triggered")
    await addExec("e1", "running", "task-1")
    expect(await dao.countActiveWork()).toBe(2)
  })

  it("an ARMED (pending) launch holds no slot — that is the queue, not the work", async () => {
    // The other axis, ux_exec_task_active, DOES count pending (identity). Conflating the
    // two makes the gate self-blocking: three armed tasks would read as "cap reached" and
    // freeze every launch behind rows that are waiting for this meter to free up.
    await addExec("e-p1", "pending", "task-p1")
    await addExec("e-p2", "pending", "task-p2")
    expect(await dao.countActiveWork()).toBe(0)
    await addExec("e-run", "running", "task-run")
    expect(await dao.countActiveWork()).toBe(1)
  })

  it("ignores finished work on both sides", async () => {
    await addSchedule("sch-wf", "workflow")
    await addFire("f-done", "sch-wf", "completed")
    await addFire("f-fail", "sch-wf", "failed")
    await addExec("e-done", "completed", "task-1")
    await addExec("e-abort", "aborted", "task-2")
    await addExec("e-free", "running", null)
    expect(await dao.countActiveWork()).toBe(0)
  })

  it("a schedule can only have ONE live fire, so the meter is per-job by construction", async () => {
    // idx_sched_execs_unique_active (partial UNIQUE on schedule_id WHERE
    // status IN ('triggered','running')) makes the "two live fires of one schedule"
    // state unrepresentable. The DISTINCT in countActiveWork is therefore belt-and-braces,
    // and one busy job is one unit of work — never two.
    await addSchedule("sch-wf", "workflow")
    await addFire("f1", "sch-wf", "running")
    expect(await dao.countActiveWork()).toBe(1)
    await expect(addFire("f2", "sch-wf", "triggered")).rejects.toThrow(/unique/i)
    expect(await dao.countActiveWork()).toBe(1)
  })

  it("does NOT count the housekeeping jobs' own fires", async () => {
    // The built-in task-lifecycle job runs every minute by design. If its fire counted,
    // it would permanently occupy 1 of the 3 real slots.
    await addSchedule("builtin-task-lifecycle", "job")
    await addFire("f-job", "builtin-task-lifecycle", "running")
    expect(await dao.countActiveWork()).toBe(0)
  })

  it("still counts a real job that happens to be scheduled alongside a housekeeping fire", async () => {
    await addSchedule("builtin-task-lifecycle", "job")
    await addFire("f-job", "builtin-task-lifecycle", "running")
    await addSchedule("sch-daily", "workflow")
    await addFire("f-wf", "sch-daily", "running")
    expect(await dao.countActiveWork()).toBe(1)
  })

  it("counts a composite's running CHILDREN — each holds a workspace and an engine", async () => {
    // Before v41 a child was its own schedule row, so the meter counted it; counting only
    // roots would have silently raised a composite task's real concurrency. The LATCH is
    // the roots-only one (a composite may run several children of one task at once) —
    // this axis is compute slots, so it is not.
    await addExec("root", "running", "task-c")
    await addExec("kid1", "running", "task-c", "root")
    await addExec("kid2", "pending", "task-c", "root")
    expect(await dao.countActiveWork()).toBe(2)
  })

  it("treats every alive status as work, including approval and interaction parks", async () => {
    // Every status that is neither terminal nor queued counts — fail-closed, so a status
    // added later still holds a slot. 'pending' is the single deliberate subtraction (the
    // armed queue), see the test above.
    for (const alive of ["running", "paused", "pending_approval", "pending_resume"]) {
      await addExec(`e-${alive}`, alive, `task-${alive}`)
    }
    expect(await dao.countActiveWork()).toBe(4)
  })

  it("honors both exclusions, since a caller is always itself in flight", async () => {
    // A claimer must not count itself: the engine has already flipped its own row to
    // claimed/running before it re-checks the cap.
    await addSchedule("sch-a", "workflow")
    await addSchedule("sch-b", "agent")
    await addFire("f-a", "sch-a", "running")
    await addFire("f-b", "sch-b", "running")
    await addExec("e1", "running", "task-1")
    expect(await dao.countActiveWork()).toBe(3)
    expect(await dao.countActiveWork({ excludeFireId: "f-a" })).toBe(2)
    expect(await dao.countActiveWork({ excludeTaskExecutionId: "e1" })).toBe(2)
    expect(await dao.countActiveWork({ excludeFireId: "f-a", excludeTaskExecutionId: "e1" })).toBe(1)
  })
})

/**
 * The two consumers of `TERMINAL_EXECUTION_STATUSES` are this DAO and the SQL-side
 * `ux_exec_task_active` partial index. SQL can't import a constant, so drift is possible
 * — and drift means either double-launching a task (index too loose) or wedging it
 * forever (index too tight). This is the only guard, so it is written as an equality on
 * the index's own DDL text rather than a re-typed list.
 */
describePg("TERMINAL_EXECUTION_STATUSES agrees with the DB latch", () => {
  it("the single-source list is exactly the ExecutionStatus set minus the alive ones", () => {
    for (const s of ["completed", "completed_with_failures", "failed", "cancelled", "skipped", "rejected"]) {
      expect(TERMINAL_EXECUTION_STATUSES).toContain(s)
    }
    for (const alive of ["pending", "running", "paused", "pending_approval", "pending_resume"]) {
      expect(TERMINAL_EXECUTION_STATUSES).not.toContain(alive)
    }
  })

  it("ux_exec_task_active's DDL lists exactly this set, nothing more or less", async () => {
    const rows = await pg.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'executions' AND indexname = 'ux_exec_task_active'`
    const ddl = rows[0]!.indexdef
    const inSql = [...ddl.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
      // The predicate also names the root marker '0' — not a status.
      .filter(v => v !== "0")
    expect(inSql.sort()).toEqual([...TERMINAL_EXECUTION_STATUSES].sort())
  })

  it("the latch and the meter agree on a status that is in neither list", async () => {
    // A newly introduced status must HOLD the slot in both places (fail-closed).
    await addExec("e-weird", "waiting_on_something_new", "task-weird")
    expect(await dao.countActiveWork()).toBe(1)
    await expect(addExec("e-weird2", "pending", "task-weird")).rejects.toThrow(/unique/i)
  })
})
