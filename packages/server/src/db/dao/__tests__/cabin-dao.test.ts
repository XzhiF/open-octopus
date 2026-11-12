import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { CabinDAO } from "../cabin-dao"
import type { CabinRow } from "../../types"

const row = (id: string, path: string): CabinRow => ({
  id, name: id, path, workspace_id: null, main_session_id: null,
  requirements: "", status: "draft", mainline_strategy: "clean-main",
  org: null, init_state: null, cockpit_prefs: null, focused_job_id: null,
  version: 1, created_at: "t0", updated_at: "t0", last_active_at: null, archived_at: null,
})

describe("CabinDAO", () => {
  let db: Database.Database
  let dao: CabinDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new CabinDAO(db)
  })
  afterEach(() => db.close())

  it("insert / findById / findByPath / list", () => {
    dao.insert(row("c1", "/a"))
    dao.insert(row("c2", "/b"))
    expect(dao.findById("c1")?.path).toBe("/a")
    expect(dao.findByPath("/b")?.id).toBe("c2")
    expect(dao.list().length).toBe(2)
    expect(dao.list("draft").length).toBe(2)
    expect(dao.list("active").length).toBe(0)
  })

  it("updateStatus transitions", () => {
    dao.insert(row("c1", "/a"))
    dao.updateStatus("c1", "active", "t1")
    expect(dao.findById("c1")?.status).toBe("active")
  })

  it("optimistic lock: wrong version fails, right version bumps", () => {
    dao.insert(row("c1", "/a"))
    expect(dao.updateFields("c1", 99, { requirements: "x" }, "t1")).toBe(false)
    expect(dao.findById("c1")?.requirements).toBe("")
    expect(dao.updateFields("c1", 1, { requirements: "x" }, "t1")).toBe(true)
    const after = dao.findById("c1")!
    expect(after.requirements).toBe("x")
    expect(after.version).toBe(2)
  })

  it("job events are append-only (UPDATE blocked)", () => {
    dao.insert(row("c1", "/a"))
    dao.insertJob({
      id: "j1", cabin_id: "c1", kind: "task", ref_id: "t1", session_id: null,
      iteration_id: null, title: "job", mandate: null, prompt: null, priority: 0,
      created_at: "t0", ended_at: null,
    })
    dao.appendEvent({ id: "e1", job_id: "j1", cabin_id: "c1", kind: "dispatch", actor: "orchestrator", payload: "{}", created_at: "t0" })
    expect(dao.listEvents("j1").length).toBe(1)
    expect(() => db.exec("UPDATE cabin_job_events SET kind='report' WHERE id='e1'")).toThrow()
  })

  it("cascade delete removes events/jobs/iterations/cabin", () => {
    dao.insert(row("c1", "/a"))
    dao.insertIteration({ id: "i1", cabin_id: "c1", code: "M1", name: "m", sort_order: 0, status: "pending", created_at: "t0", updated_at: "t0" })
    dao.insertJob({ id: "j1", cabin_id: "c1", kind: "task", ref_id: null, session_id: null, iteration_id: "i1", title: "j", mandate: null, prompt: null, priority: 0, created_at: "t0", ended_at: null })
    dao.appendEvent({ id: "e1", job_id: "j1", cabin_id: "c1", kind: "dispatch", actor: "orchestrator", payload: "{}", created_at: "t0" })
    dao.deleteEventsByCabin("c1")
    dao.deleteJobsByCabin("c1")
    dao.deleteIterationsByCabin("c1")
    dao.delete("c1")
    expect(dao.findById("c1")).toBeUndefined()
    expect(dao.listJobs("c1").length).toBe(0)
    expect(dao.listIterations("c1").length).toBe(0)
    expect(dao.listEventsByCabin("c1").length).toBe(0)
  })

  it("backfills cabin_id/iteration_id on legacy tables via ctor ALTER", () => {
    const legacy = new Database(":memory:")
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
    `)
    new CabinDAO(legacy)
    const ws = legacy.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]
    const tk = legacy.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
    const ss = legacy.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    expect(ws.some(c => c.name === "cabin_id")).toBe(true)
    expect(tk.some(c => c.name === "cabin_id")).toBe(true)
    expect(tk.some(c => c.name === "iteration_id")).toBe(true)
    expect(ss.some(c => c.name === "cabin_id")).toBe(true)
    legacy.close()
  })
})