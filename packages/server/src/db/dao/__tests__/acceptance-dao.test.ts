import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema, SCHEMA_VERSION } from "../../schema"
import { AcceptanceDAO } from "../acceptance-dao"
import { ExecutionDAO } from "../execution-dao"

let db: Database.Database
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-acceptance-dao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
}

function tableExists(name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

/** v38-era tasks DDL (old 6-state CHECK, no workspace_id) — simulates an existing dev DB. */
const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','running','done','failed','aborted')),
  source_chat_session_id TEXT,
  task_spec TEXT NOT NULL DEFAULT '{}',
  authoring_resources TEXT NOT NULL DEFAULT '[]',
  resources TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  project_ids TEXT NOT NULL DEFAULT '[]',
  workflow_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)`

describe("02-db-acceptances-columns: schema v40 migration", () => {
  describe("fresh DB (schema.sql path)", () => {
    it("creates task_phase_acceptances with spec columns + index", () => {
      applySchema(db)
      expect(tableExists("task_phase_acceptances")).toBe(true)
      for (const c of ["id", "task_id", "phase_index", "round_index", "decision", "feedback", "decided_at"]) {
        expect(colNames("task_phase_acceptances")).toContain(c)
      }
      const idx = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_phase_acceptances' AND name LIKE 'idx_%'",
      ).all() as { name: string }[]
      expect(idx.map(i => i.name)).toContain("idx_task_phase_acceptances_task_phase")
    })

    it("executions gains phase_index/round_index; tasks gains workspace_id; version is 40", () => {
      applySchema(db)
      expect(colNames("executions")).toContain("phase_index")
      expect(colNames("executions")).toContain("round_index")
      expect(colNames("tasks")).toContain("workspace_id")
      expect(SCHEMA_VERSION).toBe(40)
      const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      expect(v).toBe(40)
    })

    it("decision CHECK accepts accepted|rejected and rejects anything else", () => {
      applySchema(db)
      const now = new Date().toISOString()
      const ins = db.prepare(
        "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      expect(() => ins.run("a1", "t1", 0, 1, "accepted", null, now)).not.toThrow()
      expect(() => ins.run("a2", "t1", 0, 2, "rejected", "fix it", now)).not.toThrow()
      expect(() => ins.run("a3", "t1", 0, 3, "pending", null, now)).toThrow()
    })

    it("fresh tasks.status CHECK allows the K3 set + keeps failed for v3 legacy", () => {
      applySchema(db)
      const now = new Date().toISOString()
      for (const status of ["draft", "ready", "running", "awaiting_review", "archiving", "done", "failed", "aborted"]) {
        expect(() =>
          db.prepare(`
            INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
            VALUES (?, 'xzf', ?, ?, '{}', '[]', '[]', '[]', '[]', 1, ?, ?)
          `).run(`t-${status}`, status, status, now, now),
        ).not.toThrow()
      }
      expect(() =>
        db.prepare(`
          INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
          VALUES ('t-bad', 'xzf', 'bad', 'queued', '{}', '[]', '[]', '[]', '[]', 1, ?, ?)
        `).run(now, now),
      ).toThrow()
    })
  })

  describe("re-entrancy (AC1)", () => {
    it("applySchema twice on the same fresh DB is a no-op — no error, data kept", () => {
      applySchema(db)
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("a1", "t1", 0, 1, "accepted", null, now)
      expect(() => applySchema(db)).not.toThrow()
      expect(() => applySchema(db)).not.toThrow()
      const cnt = (db.prepare("SELECT COUNT(*) as cnt FROM task_phase_acceptances").get() as { cnt: number }).cnt
      expect(cnt).toBe(1)
    })

    it("legacy DB (v38-era tasks + executions): adds cols, rebuilds CHECK, preserves rows; second run no-ops", () => {
      // Simulate a v38-era DB: legacy tasks (old CHECK, no workspace_id) with one row,
      // legacy executions without phase/round cols.
      db.exec(LEGACY_TASKS_DDL)
      const now = new Date().toISOString()
      db.prepare(`
        INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
        VALUES ('legacy-1', 'xzf', 'E2E_TEST_legacy', 'running', '{"goal":"g"}', '[]', '[]', '[]', '[]', 3, ?, ?)
      `).run(now, now)

      applySchema(db)
      // New columns present on the migrated tables
      expect(colNames("tasks")).toContain("workspace_id")
      expect(colNames("executions")).toContain("phase_index")
      expect(colNames("executions")).toContain("round_index")
      // Legacy row preserved through the CHECK rebuild
      const row = db.prepare("SELECT * FROM tasks WHERE id='legacy-1'").get() as {
        status: string; version: number; workspace_id: string | null; name: string
      }
      expect(row.status).toBe("running")
      expect(row.version).toBe(3)
      expect(row.name).toBe("E2E_TEST_legacy")
      expect(row.workspace_id).toBeNull()
      // CHECK now allows the K3 states on the rebuilt table
      expect(() =>
        db.prepare("UPDATE tasks SET status='awaiting_review' WHERE id='legacy-1'").run(),
      ).not.toThrow()
      expect(() =>
        db.prepare("UPDATE tasks SET status='archiving' WHERE id='legacy-1'").run(),
      ).not.toThrow()

      // Re-entrant: second + third applySchema must not error or wipe data
      expect(() => applySchema(db)).not.toThrow()
      expect(() => applySchema(db)).not.toThrow()
      const cnt = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE id='legacy-1'").get() as { cnt: number }).cnt
      expect(cnt).toBe(1)
    })
  })
})

describe("AcceptanceDAO (append-only ledger)", () => {
  let dao: AcceptanceDAO

  beforeEach(() => {
    applySchema(db)
    dao = new AcceptanceDAO(db)
  })

  it("inserts accepted/rejected rows and round-trips all fields", () => {
    const r1 = dao.insert({ id: "acc-1", task_id: "task-A", phase_index: 0, round_index: 1, decision: "accepted" })
    expect(r1.changes).toBe(1)
    const r2 = dao.insert({
      id: "acc-2", task_id: "task-A", phase_index: 1, round_index: 1,
      decision: "rejected", feedback: "E2E_TEST_ fix the flaky test",
    })
    expect(r2.changes).toBe(1)

    const rows = dao.listByTask("task-A")
    expect(rows).toHaveLength(2)
    const a1 = rows.find(r => r.id === "acc-1")!
    expect(a1.task_id).toBe("task-A")
    expect(a1.phase_index).toBe(0)
    expect(a1.round_index).toBe(1)
    expect(a1.decision).toBe("accepted")
    expect(a1.feedback).toBeNull()
    // decided_at defaults to a parseable ISO timestamp
    expect(() => new Date(a1.decided_at).toISOString()).not.toThrow()
    const a2 = rows.find(r => r.id === "acc-2")!
    expect(a2.decision).toBe("rejected")
    expect(a2.feedback).toBe("E2E_TEST_ fix the flaky test")
  })

  it("insert rejects a decision outside accepted|rejected (CHECK)", () => {
    expect(() =>
      dao.insert({ id: "acc-bad", task_id: "task-A", phase_index: 0, round_index: 1, decision: "maybe" as "accepted" }),
    ).toThrow()
  })

  it("list is scoped: by task, by (task, phase), by (task, phase, round)", () => {
    const base = { task_id: "task-A", decision: "accepted" as const }
    dao.insert({ ...base, id: "p0r1", phase_index: 0, round_index: 1 })
    dao.insert({ ...base, id: "p0r2", phase_index: 0, round_index: 2 })
    dao.insert({ ...base, id: "p1r1", phase_index: 1, round_index: 1 })
    dao.insert({ ...base, id: "other-task", task_id: "task-B", phase_index: 0, round_index: 1 })

    expect(dao.listByTask("task-A").map(r => r.id)).toEqual(["p0r1", "p0r2", "p1r1"]) // (phase, round, decided_at) order
    expect(dao.listByPhase("task-A", 0).map(r => r.id)).toEqual(["p0r1", "p0r2"])
    expect(dao.listByRound("task-A", 0, 2).map(r => r.id)).toEqual(["p0r2"])
    expect(dao.listByRound("task-A", 5, 5)).toEqual([])
  })

  it("AC2 append-only: DAO exposes no update/delete/decide-mutation surface", () => {
    for (const forbidden of ["update", "delete", "remove", "upsert", "amend", "revoke"]) {
      expect((dao as unknown as Record<string, unknown>)[forbidden], `AcceptanceDAO.${forbidden} must not exist`).toBeUndefined()
    }
    // Public surface is exactly insert + list*
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(dao)).filter(n => n !== "constructor")
    expect(methods.sort()).toEqual(["insert", "listByPhase", "listByRound", "listByTask"])
  })

  it("AC2 append-only: DB triggers reject raw UPDATE/DELETE", () => {
    dao.insert({ id: "acc-imm", task_id: "task-A", phase_index: 0, round_index: 1, decision: "rejected", feedback: "v1" })
    expect(() =>
      db.prepare("UPDATE task_phase_acceptances SET feedback='tampered' WHERE id='acc-imm'").run(),
    ).toThrow(/append-only/)
    expect(() =>
      db.prepare("DELETE FROM task_phase_acceptances WHERE id='acc-imm'").run(),
    ).toThrow(/append-only/)
    // row untouched
    expect(dao.listByRound("task-A", 0, 1)[0].feedback).toBe("v1")
  })
})

describe("ExecutionDAO phase_index/round_index (v40 round identity)", () => {
  let execDao: ExecutionDAO

  beforeEach(() => {
    applySchema(db)
    execDao = new ExecutionDAO(db)
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('ws-1', 'w', 'xzf', '/tmp/w', '2026-01-01', '2026-01-01')",
    ).run()
  })

  it("insertExecution persists phase/round; NULL default for v3/generic rows", () => {
    execDao.insertExecution({
      id: "exec-p0r1", workspace_id: "ws-1", org: "xzf",
      workflow_ref: "built-in/x", workflow_name: "x",
      phase_index: 0, round_index: 1,
    } as never)
    execDao.insertExecution({
      id: "exec-legacy", workspace_id: "ws-1", org: "xzf",
      workflow_ref: "built-in/y", workflow_name: "y",
    } as never)

    const v4 = execDao.findById("exec-p0r1")!
    expect(v4.phase_index).toBe(0)
    expect(v4.round_index).toBe(1)
    const legacy = execDao.findById("exec-legacy")!
    expect(legacy.phase_index).toBeNull()
    expect(legacy.round_index).toBeNull()
  })

  it("updateExecution allows phase_index/round_index and rejects other unknown cols", () => {
    execDao.insertExecution({
      id: "exec-upd", workspace_id: "ws-1", org: "xzf",
      workflow_ref: "built-in/x", workflow_name: "x",
    } as never)
    const r = execDao.updateExecution("exec-upd", { phase_index: 2, round_index: 3 })
    expect(r.changes).toBe(1)
    const got = execDao.findById("exec-upd")!
    expect(got.phase_index).toBe(2)
    expect(got.round_index).toBe(3)
    expect(() => execDao.updateExecution("exec-upd", { nope: 1 } as never)).toThrow(/Disallowed column/)
  })
})
