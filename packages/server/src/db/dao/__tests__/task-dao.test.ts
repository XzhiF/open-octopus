import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema, SCHEMA_VERSION } from "../../schema"
import { TaskDAO } from "../task-dao"
import { ScheduleConfigDAO } from "../schedule-config-dao"
import type { TaskRow } from "../../types"

let db: Database.Database
let taskDao: TaskDAO
let schedDao: ScheduleConfigDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-task-dao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  taskDao = new TaskDAO(db)
  schedDao = new ScheduleConfigDAO(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
}

function makeTaskRow(overrides: Partial<TaskRow> & { id: string; org: string; name: string } = {
  id: "task-1", org: "xzf", name: "E2E_TD_my-task",
}): TaskRow {
  const now = new Date().toISOString()
  return {
    id: overrides.id,
    org: overrides.org,
    name: overrides.name,
    status: overrides.status ?? "draft",
    task_spec: overrides.task_spec ?? JSON.stringify({ goal: "build X", ac: ["ac1"] }),
    authoring_resources: overrides.authoring_resources ?? "[]",
    resources: overrides.resources ?? "[]",
    skills: overrides.skills ?? "[]",
    project_ids: overrides.project_ids ?? "[]",
    workflow_ref: overrides.workflow_ref ?? null,
    version: overrides.version ?? 1,
    source_chat_session_id: overrides.source_chat_session_id ?? null,
    deleted_at: overrides.deleted_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    completed_at: overrides.completed_at ?? null,
    workspace_id: overrides.workspace_id ?? null,
  }
}

describe("02-db-schema: tasks table + schedules-as-definition (v42)", () => {
  describe("schema", () => {
    it("schema version is 42+ (v42 = ADR-0021 票03; v43 = token-capture-1 票01)", () => {
      const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      // Live-constant convention (见 schema-migration v35 suite 注释)：exact pin lives
      // in schema-migration.test.ts, so later version bumps don't re-break this suite.
      expect(v).toBe(SCHEMA_VERSION)
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(42)
    })

    it("creates the tasks table with all required columns and no schedule_id/execution_id/claimed_at", () => {
      const cols = colNames("tasks")
      // Required columns present
      for (const c of [
        "id", "org", "name", "status",
        "source_chat_session_id", "task_spec", "authoring_resources",
        "resources", "skills", "project_ids", "workflow_ref",
        "version", "deleted_at", "created_at", "updated_at", "completed_at",
      ]) {
        expect(cols).toContain(c)
      }
      // S2 — no schedule pointers on tasks (lookups via schedules.origin_id)
      expect(cols).not.toContain("schedule_id")
      expect(cols).not.toContain("execution_id")
      expect(cols).not.toContain("claimed_at")
    })

    it("schedules has NO task-shaped columns left (v42: a schedule is a job definition)", () => {
      const cols = colNames("schedules")
      // Every one of these existed to bind a definition to a task, or to park an
      // envelope's run state. None of them may come back without a reason: the task's
      // WHEN is tasks.trigger_*, its runs are executions with task_id.
      for (const gone of ["origin_type", "origin_id", "origin_role", "assoc_meta", "scheduled_at"]) {
        expect(cols).not.toContain(gone)
      }
      // The pump's own run-state for its cron/agent jobs survives.
      for (const kept of ["status", "claimed_at", "next_trigger_at", "enabled", "job_type", "config"]) {
        expect(cols).toContain(kept)
      }
    })

    it("an existing v41 DB loses the task columns on the next applySchema (no wipe needed)", () => {
      // Dev-stage rule says a wipe is acceptable; the migration exists so a wipe is not
      // REQUIRED — and because DROP COLUMN fails on an indexed column, this also pins
      // that the two indexes are removed first (a silent catch-and-skip would leave the
      // columns in place and every reader of ScheduleRow typing a field that is not there).
      const legacy = new Database(":memory:")
      applySchema(legacy)
      legacy.exec(`
        ALTER TABLE schedules ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'cron';
        ALTER TABLE schedules ADD COLUMN origin_id TEXT;
        ALTER TABLE schedules ADD COLUMN origin_role TEXT;
        ALTER TABLE schedules ADD COLUMN assoc_meta TEXT;
        ALTER TABLE schedules ADD COLUMN scheduled_at TEXT;
        CREATE INDEX idx_schedules_origin ON schedules(origin_type, origin_id) WHERE deleted_at IS NULL;
        CREATE INDEX idx_schedules_due ON schedules(scheduled_at) WHERE deleted_at IS NULL AND status = 'queued';
      `)
      legacy.exec(`
        INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config,
                               created_at, updated_at, origin_type, origin_id)
        VALUES ('old-1', 'xzf', 'keepme', '0 0 * * *', 'UTC', 1, 'workflow', '{}',
                datetime('now'), datetime('now'), 'cron', NULL);
      `)
      applySchema(legacy)

      const cols = (legacy.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]).map(c => c.name)
      for (const gone of ["origin_type", "origin_id", "origin_role", "assoc_meta", "scheduled_at"]) {
        expect(cols).not.toContain(gone)
      }
      // The migration must not damage the rows it did not target.
      expect((legacy.prepare("SELECT name FROM schedules WHERE id='old-1'").get() as { name: string }).name).toBe("keepme")
      legacy.close()
    })

    it("tasks.status CHECK permits the 6 lifecycle states", () => {
      const now = new Date().toISOString()
      for (const status of ["draft", "ready", "running", "done", "failed", "aborted"]) {
        db.prepare(`
          INSERT OR REPLACE INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, deleted_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', '[]', '[]', '[]', '[]', 1, NULL, ?, ?)
        `).run(`t-${status}`, "xzf", `name-${status}`, status, now, now)
      }
      // Invalid status should be rejected by CHECK
      expect(() =>
        db.prepare(`
          INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, deleted_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', '[]', '[]', '[]', '[]', 1, NULL, ?, ?)
        `).run("t-bad", "xzf", "bad", "queued", now, now),
      ).toThrow()
    })
  })

  describe("TaskDAO round-trip", () => {
    it("inserts and retrieves a task by id", () => {
      const row = makeTaskRow({ id: "task-ins-1", org: "xzf", name: "E2E_TD_ins" })
      taskDao.insert(row)
      const got = taskDao.getById("task-ins-1")
      expect(got).not.toBeNull()
      expect(got!.id).toBe("task-ins-1")
      expect(got!.org).toBe("xzf")
      expect(got!.name).toBe("E2E_TD_ins")
      expect(got!.status).toBe("draft")
      expect(got!.version).toBe(1)
      expect(got!.deleted_at).toBeNull()
      expect(got!.task_spec).toBe(JSON.stringify({ goal: "build X", ac: ["ac1"] }))
    })

    it("getById returns null for missing or soft-deleted task", () => {
      expect(taskDao.getById("nope")).toBeNull()
      const row = makeTaskRow({ id: "task-del", org: "xzf", name: "E2E_TD_del" })
      taskDao.insert(row)
      taskDao.softDelete("task-del")
      // getById (active) excludes soft-deleted
      expect(taskDao.getById("task-del")).toBeNull()
      // getByIdRaw includes soft-deleted
      const raw = taskDao.getByIdRaw("task-del")
      expect(raw).not.toBeNull()
      expect(raw!.deleted_at).not.toBeNull()
    })

    it("updates task fields and bumps version", () => {
      const row = makeTaskRow({ id: "task-upd", org: "xzf", name: "E2E_TD_upd" })
      taskDao.insert(row)
      const result = taskDao.updateWithVersion("task-upd", {
        status: "ready",
        name: "E2E_TD_upd-renamed",
        workflow_ref: "built-in/composition-task",
      }, 1)
      expect(result.changes).toBe(1)
      const got = taskDao.getById("task-upd")
      expect(got!.status).toBe("ready")
      expect(got!.name).toBe("E2E_TD_upd-renamed")
      expect(got!.workflow_ref).toBe("built-in/composition-task")
      expect(got!.version).toBe(2)
    })

    it("updateWithVersion rejects stale version (optimistic concurrency)", () => {
      const row = makeTaskRow({ id: "task-occ", org: "xzf", name: "E2E_TD_occ" })
      taskDao.insert(row)
      // Bump to v2
      taskDao.updateWithVersion("task-occ", { status: "ready" }, 1)
      // Stale update against v1 should affect 0 rows
      const result = taskDao.updateWithVersion("task-occ", { status: "running" }, 1)
      expect(result.changes).toBe(0)
      const got = taskDao.getById("task-occ")
      expect(got!.status).toBe("ready")
      expect(got!.version).toBe(2)
    })

    it("lists tasks by status, excluding soft-deleted", () => {
      const now = new Date().toISOString()
      taskDao.insert(makeTaskRow({ id: "ls-draft-1", org: "xzf", name: "E2E_TD_d1", status: "draft", created_at: now }))
      taskDao.insert(makeTaskRow({ id: "ls-draft-2", org: "xzf", name: "E2E_TD_d2", status: "draft", created_at: now }))
      taskDao.insert(makeTaskRow({ id: "ls-ready-1", org: "xzf", name: "E2E_TD_r1", status: "ready", created_at: now }))
      taskDao.insert(makeTaskRow({ id: "ls-done-1", org: "xzf", name: "E2E_TD_done", status: "done", created_at: now, completed_at: now }))

      const drafts = taskDao.listByStatus("draft")
      expect(drafts.map(t => t.id)).toEqual(["ls-draft-1", "ls-draft-2"])

      const ready = taskDao.listByStatus("ready")
      expect(ready.map(t => t.id)).toEqual(["ls-ready-1"])

      const done = taskDao.listByStatus("done")
      expect(done.map(t => t.id)).toEqual(["ls-done-1"])
    })

    it("lists by org across all non-terminal statuses (kanban)", () => {
      const now = new Date().toISOString()
      taskDao.insert(makeTaskRow({ id: "kb-d", org: "xzf", name: "E2E_TD_kd", status: "draft", created_at: now }))
      taskDao.insert(makeTaskRow({ id: "kb-r", org: "xzf", name: "E2E_TD_kr", status: "ready", created_at: now }))
      taskDao.insert(makeTaskRow({ id: "kb-x", org: "other", name: "E2E_TD_kx", status: "draft", created_at: now }))
      // soft-deleted should be excluded
      taskDao.insert(makeTaskRow({ id: "kb-del", org: "xzf", name: "E2E_TD_kdel", status: "draft", created_at: now }))
      taskDao.softDelete("kb-del")

      const items = taskDao.listByOrg("xzf")
      const ids = items.map(t => t.id)
      expect(ids).toContain("kb-d")
      expect(ids).toContain("kb-r")
      expect(ids).not.toContain("kb-x")
      expect(ids).not.toContain("kb-del")
    })

    it("softDelete sets deleted_at (active row hidden, raw row kept)", () => {
      const row = makeTaskRow({ id: "task-sd", org: "xzf", name: "E2E_TD_sd" })
      taskDao.insert(row)
      expect(taskDao.getById("task-sd")).not.toBeNull() // active before
      const result = taskDao.softDelete("task-sd")
      expect(result.changes).toBe(1)
      // active lookup now hides it
      expect(taskDao.getById("task-sd")).toBeNull()
      // raw lookup still returns the row, with deleted_at set
      const raw = taskDao.getByIdRaw("task-sd")!
      expect(raw.deleted_at).not.toBeNull()
      // re-soft-deleting a deleted row is a no-op (changes=0 — idempotent)
      expect(taskDao.softDelete("task-sd").changes).toBe(0)
    })
  })

  describe("AC3: tasks.workspace_id round-trip (v40, K4 ws reuse)", () => {
    it("insert writes workspace_id; NULL when not provided (never triggered)", () => {
      taskDao.insert(makeTaskRow({ id: "ws-1", org: "xzf", name: "E2E_TD_ws1", workspace_id: "ws-abc" }))
      taskDao.insert(makeTaskRow({ id: "ws-2", org: "xzf", name: "E2E_TD_ws2" }))
      expect(taskDao.getById("ws-1")!.workspace_id).toBe("ws-abc")
      expect(taskDao.getById("ws-2")!.workspace_id).toBeNull()
    })

    it("updateWithVersion binds workspace_id (first-trigger write-back, 票 05 pattern)", () => {
      taskDao.insert(makeTaskRow({ id: "ws-3", org: "xzf", name: "E2E_TD_ws3", status: "ready" }))
      const r = taskDao.updateWithVersion("ws-3", { status: "running", workspace_id: "ws-new" }, 1)
      expect(r.changes).toBe(1)
      const got = taskDao.getById("ws-3")!
      expect(got.workspace_id).toBe("ws-new")
      expect(got.status).toBe("running")
      expect(got.version).toBe(2)
    })
  })

  describe("ScheduleConfigDAO — a definition row, and nothing else", () => {
    it("insertSchedule writes a job definition without any task back-reference", () => {
      const now = new Date().toISOString()
      const result = schedDao.insertSchedule({
        id: "sched-def-1", org: "xzf", name: "E2E_TD_def",
        cron_expression: "0 0 * * *", timezone: "Asia/Shanghai",
        config: JSON.stringify({ schema_version: "3.0", type: "workflow" }),
        created_at: now, updated_at: now,
      } as any)
      expect(result.changes).toBe(1)
      const got = schedDao.findById("sched-def-1")!
      expect(got.name).toBe("E2E_TD_def")
      // The columns are gone from the row type too — asserting the SHAPE here is what
      // keeps a future caller from quietly reintroducing one through `as any`.
      expect(Object.keys(got)).not.toContain("origin_type")
      expect(Object.keys(got)).not.toContain("origin_id")
    })

    it("the task-walking finders are gone from the DAO", () => {
      // These four existed solely to answer 「这个任务的内在哪」 from the scheduler side.
      for (const gone of [
        "findSchedulesByOrigin", "findRootSchedulesByTaskIds",
        "findQueuedSchedules", "claimParkedTaskSchedule", "cancelTriggeredTaskSchedule",
        "findFailedChildSchedules",
      ]) {
        expect(typeof (schedDao as any)[gone]).not.toBe("function")
      }
    })
  })
})
