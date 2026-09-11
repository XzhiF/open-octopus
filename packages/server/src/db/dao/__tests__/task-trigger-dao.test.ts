import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../schema"
import { TaskDAO } from "../task-dao"
import type { TaskRow } from "../../types"

/**
 * S1 (task-scheduler-decouple / ADR-0021) — `tasks.trigger_*`: WHEN a task wants to run
 * is now the task's own column set.
 *
 * These tests exist to pin the two properties that make the decoupling safe:
 *   (1) `next_fire_at` is the ONE cursor the pump's due-scan reads — so a fire that
 *       forgets to advance/retire it would re-enqueue forever (the once case below).
 *   (2) trigger writes never bump `version`, because arming is not a spec edit and must
 *       not 409 a concurrent autosave/spec-field write.
 */

let db: Database.Database
let dao: TaskDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-task-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new TaskDAO(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function makeTask(id: string, status = "ready"): TaskRow {
  const now = new Date().toISOString()
  const row: TaskRow = {
    id, org: "xzf", name: `T_${id}`, status,
    task_spec: JSON.stringify({ goal: "g", ac: ["a"] }),
    authoring_resources: "[]", resources: "[]", skills: "[]", project_ids: "[]",
    workflow_ref: null, version: 1, source_chat_session_id: null,
    deleted_at: null, created_at: now, updated_at: now, completed_at: null,
    workspace_id: null,
    trigger_mode: "manual", trigger_at: null, cron_expression: null,
    cron_timezone: "Asia/Shanghai", trigger_enabled: 1, next_fire_at: null, last_fired_at: null,
  }
  dao.insert(row)
  return row
}

function get(id: string): TaskRow {
  return dao.getById(id)!
}

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
}

describe("tasks v41 trigger columns", () => {
  it("fresh rows default to manual / enabled / no cursor", () => {
    for (const c of ["trigger_mode", "trigger_at", "cron_expression", "cron_timezone",
      "trigger_enabled", "next_fire_at", "last_fired_at"]) {
      expect(colNames("tasks")).toContain(c)
    }
    const t = makeTask("t-default")
    expect([t.trigger_mode, t.trigger_enabled, t.next_fire_at, t.last_fired_at])
      .toEqual(["manual", 1, null, null])
    expect(get("t-default").cron_timezone).toBe("Asia/Shanghai")
  })

  it("the due-scan index exists so the pump's scan stays cheap", () => {
    const idx = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_due'",
    ).get() as { sql: string } | undefined)?.sql ?? ""
    expect(idx).toContain("next_fire_at")
    expect(idx).toContain("status = 'ready'")
  })
})

describe("TaskDAO — arming", () => {
  it("armOnce sets a one-shot cursor at the requested time", () => {
    makeTask("t-once")
    expect(dao.armOnce("t-once", "2026-09-09T10:00:00.000Z")).toBe(true)
    const t = get("t-once")
    expect([t.trigger_mode, t.trigger_at, t.next_fire_at, t.trigger_enabled])
      .toEqual(["once", "2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.000Z", 1])
  })

  it("armCron records the expression, retires trigger_at, and arms the computed cursor", () => {
    makeTask("t-cron")
    dao.armOnce("t-cron", "2026-09-09T10:00:00.000Z")
    expect(dao.armCron("t-cron", "0 9 * * *", "Asia/Shanghai", "2026-09-10T01:00:00.000Z")).toBe(true)
    const t = get("t-cron")
    expect([t.trigger_mode, t.cron_expression, t.cron_timezone, t.trigger_at, t.next_fire_at])
      .toEqual(["cron", "0 9 * * *", "Asia/Shanghai", null, "2026-09-10T01:00:00.000Z"])
  })

  it("disarm returns to manual and removes every cursor", () => {
    makeTask("t-disarm")
    dao.armCron("t-disarm", "0 9 * * *", "UTC", "2026-09-10T01:00:00.000Z")
    expect(dao.disarmTrigger("t-disarm")).toBe(true)
    const t = get("t-disarm")
    expect([t.trigger_mode, t.cron_expression, t.trigger_at, t.next_fire_at])
      .toEqual(["manual", null, null, null])
    // Manual is still re-armable (立即触发 writes armOnce again).
    expect(dao.armOnce("t-disarm", "2026-09-09T00:00:00.000Z")).toBe(true)
  })

  it("setTriggerEnabled pauses and resumes without dropping the cron expression", () => {
    makeTask("t-pause")
    dao.armCron("t-pause", "*/10 * * * *", "UTC", "2026-09-09T00:00:00.000Z")
    expect(dao.setTriggerEnabled("t-pause", false)).toBe(true)
    expect(get("t-pause").cron_expression).toBe("*/10 * * * *")
    expect(dao.findDueTriggers("2099-01-01T00:00:00.000Z").map(r => r.id)).not.toContain("t-pause")
    expect(dao.setTriggerEnabled("t-pause", true)).toBe(true)
    expect(dao.findDueTriggers("2099-01-01T00:00:00.000Z").map(r => r.id)).toContain("t-pause")
  })

  it("does not bump version — arming is not a spec edit", () => {
    const t = makeTask("t-version")
    dao.armOnce("t-version", "2026-09-09T10:00:00.000Z")
    dao.armCron("t-version", "0 9 * * *", "UTC", "2026-09-10T01:00:00.000Z")
    dao.setTriggerEnabled("t-version", false)
    dao.disarmTrigger("t-version")
    expect(get("t-version").version).toBe(t.version)
  })
})

describe("TaskDAO — due scan + fire bookkeeping", () => {
  it("scans only ready, live, enabled tasks with a due cursor", () => {
    makeTask("d-ready-due", "ready")
    makeTask("d-ready-future", "ready")
    makeTask("d-draft", "draft")
    makeTask("d-running", "running")
    makeTask("d-deleted", "ready")
    dao.armOnce("d-ready-due", "2026-09-09T00:01:00.000Z")
    dao.armOnce("d-ready-future", "2027-01-01T00:00:00.000Z")
    dao.armOnce("d-draft", "2026-09-09T00:00:00.000Z")
    dao.armOnce("d-running", "2026-09-09T00:00:00.000Z")
    dao.armOnce("d-deleted", "2026-09-09T00:00:00.000Z")
    dao.softDelete("d-deleted")

    expect(dao.findDueTriggers("2026-09-09T00:10:00.000Z").map(r => r.id)).toEqual(["d-ready-due"])
    // Cursor order, not insertion order.
    makeTask("d-ready-earlier")
    dao.armOnce("d-ready-earlier", "2026-09-09T00:00:30.000Z")
    const due = dao.findDueTriggers("2026-09-09T00:10:00.000Z").map(r => r.id)
    expect(due).toEqual(["d-ready-earlier", "d-ready-due"])
  })

  it("respects the scan limit", () => {
    for (let i = 0; i < 4; i++) {
      makeTask(`cap-${i}`)
      dao.armOnce(`cap-${i}`, `2026-09-09T00:0${i}:00.000Z`)
    }
    expect(dao.findDueTriggers("2026-09-09T01:00:00.000Z", 2).length).toBe(2)
  })

  it("a once fire retires its cursor so the pump never re-enqueues it", () => {
    makeTask("f-once")
    dao.armOnce("f-once", "2026-09-09T00:00:00.000Z")
    expect(dao.markFired("f-once", null, "2026-09-09T00:00:01.000Z")).toBe(true)
    const t = get("f-once")
    expect(t.next_fire_at).toBeNull()
    expect(t.last_fired_at).toBe("2026-09-09T00:00:01.000Z")
    expect(t.trigger_at).toBeNull()
    expect(dao.findDueTriggers("2099-01-01T00:00:00.000Z").map(r => r.id)).not.toContain("f-once")
  })

  it("a cron fire advances the cursor instead of retiring it", () => {
    makeTask("f-cron")
    dao.armCron("f-cron", "0 9 * * *", "UTC", "2026-09-09T09:00:00.000Z")
    expect(dao.markFired("f-cron", "2026-09-10T09:00:00.000Z", "2026-09-09T09:00:00.000Z")).toBe(true)
    const t = get("f-cron")
    expect([t.next_fire_at, t.cron_expression, t.trigger_mode])
      .toEqual(["2026-09-10T09:00:00.000Z", "0 9 * * *", "cron"])
  })

  it("trigger writes on a soft-deleted task are no-ops", () => {
    makeTask("f-gone")
    dao.softDelete("f-gone")
    expect(dao.armOnce("f-gone", "2026-09-09T00:00:00.000Z")).toBe(false)
    expect(dao.markFired("f-gone", null, "2026-09-09T00:00:00.000Z")).toBe(false)
  })
})

/**
 * The single-instance latch. A task launch IS an `executions` row (v41 — no separate
 * run ledger), so "one task, one live instance" is enforced by `ux_exec_task_active`,
 * a partial UNIQUE index over the active statuses. This replaces ~10 guard queries in
 * the task service plus the pre-v41 trick of borrowing schedule_executions' UNIQUE index
 * to serialize v4 rounds. Terminal statuses release the slot by falling out of the
 * index's WHERE clause.
 */
describe("ux_exec_task_active — one live execution per task", () => {
  const now = "2026-09-09T00:00:00.000Z"

  function seedWorkspace(id: string): void {
    db.prepare(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, `W_${id}`, "xzf", `/tmp/${id}`, now, now)
  }

  function launch(id: string, taskId: string, wsId: string, status: string, parentId = "0"): void {
    db.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, task_id, parent_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, wsId, "wf/x.yaml", "x", status, "xzf", taskId, parentId, now, now)
  }

  beforeEach(() => seedWorkspace("ws-latch"))

  it("the index exists, is UNIQUE, and is written fail-closed over ROOTS", () => {
    const row = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='ux_exec_task_active'",
    ).get() as { name: string; sql: string } | undefined
    expect(row).toBeDefined()
    expect(row!.sql).toContain("UNIQUE")
    expect(row!.sql).toContain("task_id IS NOT NULL")
    expect(row!.sql).toContain("parent_id = '0'")
    // NOT IN (terminal), never IN (active) — see the DDL comment.
    expect(row!.sql).toContain("status NOT IN")
  })

  it("blocks a second live root launch for the same task", () => {
    launch("e1", "lk-1", "ws-latch", "pending")
    expect(() => launch("e2", "lk-1", "ws-latch", "running")).toThrow(/UNIQUE/)
  })

  it("a waiting approval, an interaction park, or a pause all still hold the slot", () => {
    // These five statuses are all "alive": a pending_approval execution holds a live
    // engine and a workspace, so releasing the latch there would double-run the task.
    for (const alive of ["pending", "running", "paused", "pending_approval", "pending_resume"]) {
      const id = `lk-alive-${alive}`
      launch(id, `lk-2-${alive}`, "ws-latch", alive)
      expect(() => launch(`${id}-second`, `lk-2-${alive}`, "ws-latch", "pending")).toThrow(/UNIQUE/)
    }
    // An unknown future status defaults to HOLDING — the whole point of NOT IN.
    launch("lk-future", "lk-2-future", "ws-latch", "waiting_on_something_new")
    expect(() => launch("lk-future-2", "lk-2-future", "ws-latch", "pending")).toThrow(/UNIQUE/)
  })

  it("lets a composite run several live CHILD executions of one task", () => {
    launch("root", "lk-comp", "ws-latch", "running")
    // Children are nested via the engine's existing parent_id/child_index model, so the
    // root latch leaves them alone — the built-in job schedules the fan-out itself.
    expect(() => {
      launch("c1", "lk-comp", "ws-latch", "pending", "root")
      launch("c2", "lk-comp", "ws-latch", "running", "root")
      launch("c3", "lk-comp", "ws-latch", "pending_approval", "root")
    }).not.toThrow()
    // …and a second ROOT is still refused.
    expect(() => launch("root2", "lk-comp", "ws-latch", "pending")).toThrow(/UNIQUE/)
  })

  it("releases the slot on every terminal status so the next round can launch", () => {
    for (const terminal of ["completed", "completed_with_failures", "failed", "cancelled", "aborted", "skipped", "rejected"]) {
      launch(`e-${terminal}`, "lk-3", "ws-latch", terminal)
    }
    // Seven finished rounds then a live one — the retries the board shows today.
    expect(() => launch("e-live", "lk-3", "ws-latch", "pending")).not.toThrow()
    expect(() => launch("e-live2", "lk-3", "ws-latch", "pending")).toThrow(/UNIQUE/)
  })

  it("does not constrain non-task executions or different tasks", () => {
    launch("plain-1", "lk-4", "ws-latch", "pending")
    expect(() => launch("plain-2", "lk-5", "ws-latch", "pending")).not.toThrow()
    // NULL task_id rows are outside the index predicate entirely.
    db.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("free-1", "ws-latch", "wf/x.yaml", "x", "running", "xzf", now, now)
    expect(() => db.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("free-2", "ws-latch", "wf/x.yaml", "x", "running", "xzf", now, now)).not.toThrow()
  })
})
