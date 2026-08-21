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
  }
}

describe("02-db-schema: tasks table + schedules origin migration", () => {
  describe("schema", () => {
    it("bumps schema version to 38", () => {
      const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      expect(v).toBe(38)
      expect(SCHEMA_VERSION).toBe(38)
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

    it("schedules ADDS origin_type/origin_id/origin_role/assoc_meta (trigger_source/source_chat_session_id KEPT — removal deferred to 06)", () => {
      const cols = colNames("schedules")
      // v38 ADDITIVE origin cols present
      for (const c of ["origin_type", "origin_id", "origin_role", "assoc_meta"]) {
        expect(cols).toContain(c)
      }
      // trigger cols coexist transiently (removal + 3 承重 sites migration = ticket 06)
      expect(cols).toContain("trigger_source")
      expect(cols).toContain("source_chat_session_id")
    })

    it("schedules.origin_type defaults to 'cron' for legacy cron rows", () => {
      // Insert a minimal cron schedule without specifying origin_type
      const now = new Date().toISOString()
      db.prepare(`
        INSERT INTO schedules (id, org, name, cron_expression, timezone, created_at, updated_at, config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("sched-cron-1", "xzf", "nightly", "0 0 * * *", "Asia/Shanghai", now, now, "{}")
      const row = db.prepare("SELECT origin_type FROM schedules WHERE id = ?").get("sched-cron-1") as { origin_type: string }
      expect(row.origin_type).toBe("cron")
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

  describe("ScheduleConfigDAO origin cols", () => {
    it("insertSchedule writes origin_type/origin_id/origin_role/assoc_meta", () => {
      const now = new Date().toISOString()
      const result = schedDao.insertSchedule({
        id: "sched-origin-1", org: "xzf", name: "E2E_TD_origin",
        cron_expression: null, timezone: "Asia/Shanghai",
        origin_type: "task", origin_id: "task-parent-1", origin_role: "primary",
        assoc_meta: JSON.stringify({ enqueued_by: "dispatch-seam" }),
        config: JSON.stringify({ schema_version: "3.0", type: "workflow" }),
        status: "queued", created_at: now, updated_at: now,
      } as any)
      expect(result.changes).toBe(1)

      const got = schedDao.findById("sched-origin-1")!
      expect(got.origin_type).toBe("task")
      expect(got.origin_id).toBe("task-parent-1")
      expect(got.origin_role).toBe("primary")
      expect(JSON.parse(got.assoc_meta!)).toEqual({ enqueued_by: "dispatch-seam" })
    })

    it("findSchedulesByOrigin returns child schedules for a task, ordered by created_at ASC", () => {
      const now = new Date().toISOString()
      // primary child
      schedDao.insertSchedule({
        id: "c1", org: "xzf", name: "E2E_TD_c1", cron_expression: null, timezone: "Asia/Shanghai",
        origin_type: "task", origin_id: "task-P", origin_role: "primary",
        config: "{}", status: "queued", created_at: now, updated_at: now,
      } as any)
      // subunit child (created slightly later)
      schedDao.insertSchedule({
        id: "c2", org: "xzf", name: "E2E_TD_c2", cron_expression: null, timezone: "Asia/Shanghai",
        origin_type: "task", origin_id: "task-P", origin_role: "subunit",
        config: "{}", status: "queued", created_at: now, updated_at: now,
      } as any)
      // unrelated cron + different task
      schedDao.insertSchedule({
        id: "c3", org: "xzf", name: "E2E_TD_c3", cron_expression: "0 0 * * *", timezone: "Asia/Shanghai",
        config: "{}", created_at: now, updated_at: now,
      } as any)
      schedDao.insertSchedule({
        id: "c4", org: "xzf", name: "E2E_TD_c4", cron_expression: null, timezone: "Asia/Shanghai",
        origin_type: "task", origin_id: "task-OTHER", origin_role: "primary",
        config: "{}", status: "queued", created_at: now, updated_at: now,
      } as any)

      const children = schedDao.findSchedulesByOrigin("task", "task-P")
      expect(children.map(s => s.id)).toEqual(["c1", "c2"])
      expect(children.every(s => s.origin_type === "task")).toBe(true)
      expect(children.every(s => s.origin_id === "task-P")).toBe(true)
    })
  })
})
