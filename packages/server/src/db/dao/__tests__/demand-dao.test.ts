import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../schema"
import { DemandDAO } from "../demand-dao"
import type { DemandRow } from "../../types"

let db: Database.Database
let dao: DemandDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-demand-dao-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new DemandDAO(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function makeDemand(overrides: Partial<DemandRow> = {}): DemandRow {
  const now = new Date().toISOString()
  return {
    id: `demand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test demand",
    description: "A test demand description",
    status: "draft",
    priority: "normal",
    project_ids: '["project-1"]',
    demand_workflow_ref: "spec-forge",
    exec_workflow_chain: '["spec-impl"]',
    workspace_id: null,
    ready_at: null,
    dispatched_at: null,
    completed_at: null,
    result: null,
    error_message: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe("DemandDAO", () => {
  describe("insert + findById", () => {
    it("inserts a demand and retrieves it by id", () => {
      const demand = makeDemand({ id: "demand-001" })
      dao.insert(demand)

      const found = dao.findById("demand-001")
      expect(found).not.toBeNull()
      expect(found!.id).toBe("demand-001")
      expect(found!.title).toBe("Test demand")
      expect(found!.status).toBe("draft")
      expect(found!.priority).toBe("normal")
    })

    it("returns null for non-existent id", () => {
      expect(dao.findById("nonexistent")).toBeNull()
    })

    it("stores JSON fields correctly", () => {
      const demand = makeDemand({
        id: "demand-json",
        project_ids: '["p1", "p2"]',
        exec_workflow_chain: '["wf-1", "wf-2", "wf-3"]',
      })
      dao.insert(demand)

      const found = dao.findById("demand-json")
      expect(found).not.toBeNull()
      expect(JSON.parse(found!.project_ids)).toEqual(["p1", "p2"])
      expect(JSON.parse(found!.exec_workflow_chain)).toEqual(["wf-1", "wf-2", "wf-3"])
    })

    it("stores nullable timestamp fields", () => {
      const demand = makeDemand({
        id: "demand-ts",
        ready_at: null,
        dispatched_at: null,
        completed_at: null,
      })
      dao.insert(demand)

      const found = dao.findById("demand-ts")
      expect(found!.ready_at).toBeNull()
      expect(found!.dispatched_at).toBeNull()
      expect(found!.completed_at).toBeNull()
    })
  })

  describe("list", () => {
    it("returns all demands when no filter", () => {
      dao.insert(makeDemand({ id: "d1" }))
      dao.insert(makeDemand({ id: "d2" }))
      dao.insert(makeDemand({ id: "d3" }))

      const result = dao.list({})
      expect(result.data).toHaveLength(3)
      expect(result.total).toBe(3)
    })

    it("filters by status", () => {
      dao.insert(makeDemand({ id: "d1", status: "draft" }))
      dao.insert(makeDemand({ id: "d2", status: "ready" }))
      dao.insert(makeDemand({ id: "d3", status: "draft" }))

      const result = dao.list({ status: "draft" })
      expect(result.data).toHaveLength(2)
      expect(result.data.every(d => d.status === "draft")).toBe(true)
    })

    it("filters by priority", () => {
      dao.insert(makeDemand({ id: "d1", priority: "critical" }))
      dao.insert(makeDemand({ id: "d2", priority: "normal" }))
      dao.insert(makeDemand({ id: "d3", priority: "critical" }))

      const result = dao.list({ priority: "critical" })
      expect(result.data).toHaveLength(2)
    })

    it("supports pagination", () => {
      for (let i = 0; i < 10; i++) {
        dao.insert(makeDemand({ id: `d-${i}` }))
      }

      const page1 = dao.list({ page: 1, pageSize: 3 })
      expect(page1.data).toHaveLength(3)
      expect(page1.total).toBe(10)
      expect(page1.page).toBe(1)
      expect(page1.pageSize).toBe(3)

      const page2 = dao.list({ page: 2, pageSize: 3 })
      expect(page2.data).toHaveLength(3)
      expect(page2.page).toBe(2)
    })

    it("orders by created_at DESC by default", () => {
      dao.insert(makeDemand({ id: "d-old", created_at: "2024-01-01T00:00:00Z" }))
      dao.insert(makeDemand({ id: "d-new", created_at: "2024-06-01T00:00:00Z" }))

      const result = dao.list({})
      expect(result.data[0].id).toBe("d-new")
      expect(result.data[1].id).toBe("d-old")
    })
  })

  describe("updateStatus", () => {
    it("updates the status and updated_at", () => {
      dao.insert(makeDemand({ id: "d1", status: "draft" }))

      dao.updateStatus("d1", "discussing")
      const found = dao.findById("d1")
      expect(found!.status).toBe("discussing")
    })

    it("sets ready_at when transitioning to ready", () => {
      dao.insert(makeDemand({ id: "d1", status: "incubated" }))

      dao.updateStatus("d1", "ready")
      const found = dao.findById("d1")
      expect(found!.status).toBe("ready")
      expect(found!.ready_at).not.toBeNull()
    })

    it("sets dispatched_at when transitioning to dispatched", () => {
      dao.insert(makeDemand({ id: "d1", status: "ready" }))

      dao.updateStatus("d1", "dispatched")
      const found = dao.findById("d1")
      expect(found!.status).toBe("dispatched")
      expect(found!.dispatched_at).not.toBeNull()
    })

    it("sets completed_at when transitioning to done", () => {
      dao.insert(makeDemand({ id: "d1", status: "executing" }))

      dao.updateStatus("d1", "done")
      const found = dao.findById("d1")
      expect(found!.status).toBe("done")
      expect(found!.completed_at).not.toBeNull()
    })

    it("sets completed_at when transitioning to failed", () => {
      dao.insert(makeDemand({ id: "d1", status: "executing" }))

      dao.updateStatus("d1", "failed")
      const found = dao.findById("d1")
      expect(found!.status).toBe("failed")
      expect(found!.completed_at).not.toBeNull()
    })
  })

  describe("update", () => {
    it("updates title and description", () => {
      dao.insert(makeDemand({ id: "d1", title: "Old title" }))

      dao.update("d1", { title: "New title", description: "New desc" })
      const found = dao.findById("d1")
      expect(found!.title).toBe("New title")
      expect(found!.description).toBe("New desc")
    })

    it("updates priority", () => {
      dao.insert(makeDemand({ id: "d1", priority: "normal" }))

      dao.update("d1", { priority: "critical" })
      const found = dao.findById("d1")
      expect(found!.priority).toBe("critical")
    })

    it("ignores disallowed fields", () => {
      dao.insert(makeDemand({ id: "d1" }))

      // Should not throw, just ignore id/created_at
      dao.update("d1", { id: "hacked", title: "Updated" } as any)
      const found = dao.findById("d1") // still findable by original id
      expect(found).not.toBeNull()
      expect(found!.title).toBe("Updated")
    })
  })

  describe("delete", () => {
    it("deletes a demand by id", () => {
      dao.insert(makeDemand({ id: "d1" }))
      expect(dao.findById("d1")).not.toBeNull()

      dao.delete("d1")
      expect(dao.findById("d1")).toBeNull()
    })

    it("returns silently for non-existent id", () => {
      expect(() => dao.delete("nonexistent")).not.toThrow()
    })
  })

  describe("listReady", () => {
    it("returns only ready demands ordered by priority then created_at", () => {
      dao.insert(makeDemand({ id: "d1", status: "ready", priority: "low", created_at: "2024-01-01T00:00:00Z" }))
      dao.insert(makeDemand({ id: "d2", status: "ready", priority: "critical", created_at: "2024-01-02T00:00:00Z" }))
      dao.insert(makeDemand({ id: "d3", status: "draft", priority: "critical" }))
      dao.insert(makeDemand({ id: "d4", status: "ready", priority: "normal", created_at: "2024-01-03T00:00:00Z" }))

      const result = dao.listReady()
      expect(result).toHaveLength(3)
      // critical first, then normal, then low
      expect(result[0].id).toBe("d2")
      expect(result[1].id).toBe("d4")
      expect(result[2].id).toBe("d1")
    })

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        dao.insert(makeDemand({ id: `d-${i}`, status: "ready" }))
      }

      const result = dao.listReady(5)
      expect(result).toHaveLength(5)
    })
  })

  describe("countByStatus", () => {
    it("returns counts grouped by status", () => {
      dao.insert(makeDemand({ id: "d1", status: "draft" }))
      dao.insert(makeDemand({ id: "d2", status: "draft" }))
      dao.insert(makeDemand({ id: "d3", status: "ready" }))
      dao.insert(makeDemand({ id: "d4", status: "done" }))

      const counts = dao.countByStatus()
      expect(counts.draft).toBe(2)
      expect(counts.ready).toBe(1)
      expect(counts.done).toBe(1)
    })
  })

  describe("setError", () => {
    it("sets error_message on a demand", () => {
      dao.insert(makeDemand({ id: "d1" }))

      dao.setError("d1", "Something went wrong")
      const found = dao.findById("d1")
      expect(found!.error_message).toBe("Something went wrong")
    })

    it("clears error_message when set to null", () => {
      dao.insert(makeDemand({ id: "d1", error_message: "old error" }))

      dao.setError("d1", null)
      const found = dao.findById("d1")
      expect(found!.error_message).toBeNull()
    })
  })
})

describe("Demands Schema — CHECK constraints", () => {
  let schemaDb: Database.Database

  afterEach(() => {
    schemaDb?.close()
  })

  it("has all required columns", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)

    const cols = schemaDb.prepare("PRAGMA table_info(demands)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(expect.arrayContaining([
      "id", "title", "description", "status", "priority",
      "project_ids", "demand_workflow_ref", "exec_workflow_chain",
      "workspace_id", "ready_at", "dispatched_at", "completed_at",
      "result", "error_message", "created_at", "updated_at",
    ]))
  })

  it("rejects invalid status values", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)

    expect(() => {
      schemaDb.prepare(
        `INSERT INTO demands (id, title, status, priority, project_ids, demand_workflow_ref, exec_workflow_chain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("bad-status", "Test", "invalid_status", "normal", "[]", "wf", "[]", "2024-01-01", "2024-01-01")
    }).toThrow()
  })

  it("accepts all 7 valid status values", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)

    const validStatuses = ["draft", "discussing", "incubated", "ready", "dispatched", "executing", "done", "failed"]
    for (const status of validStatuses) {
      schemaDb.prepare(
        `INSERT INTO demands (id, title, status, priority, project_ids, demand_workflow_ref, exec_workflow_chain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`d-${status}`, "Test", status, "normal", "[]", "wf", "[]", "2024-01-01", "2024-01-01")
    }

    const count = (schemaDb.prepare("SELECT COUNT(*) as cnt FROM demands").get() as { cnt: number }).cnt
    expect(count).toBe(validStatuses.length)
  })

  it("rejects invalid priority values", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)

    expect(() => {
      schemaDb.prepare(
        `INSERT INTO demands (id, title, status, priority, project_ids, demand_workflow_ref, exec_workflow_chain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("bad-priority", "Test", "draft", "ultra", "[]", "wf", "[]", "2024-01-01", "2024-01-01")
    }).toThrow()
  })

  it("accepts all valid priority values", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)

    const validPriorities = ["low", "normal", "high", "critical"]
    for (const priority of validPriorities) {
      schemaDb.prepare(
        `INSERT INTO demands (id, title, status, priority, project_ids, demand_workflow_ref, exec_workflow_chain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`d-${priority}`, "Test", "draft", priority, "[]", "wf", "[]", "2024-01-01", "2024-01-01")
    }

    const count = (schemaDb.prepare("SELECT COUNT(*) as cnt FROM demands").get() as { cnt: number }).cnt
    expect(count).toBe(validPriorities.length)
  })

  it("creates demands indexes", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)

    const indexes = schemaDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='demands'"
    ).all() as { name: string }[]
    const idxNames = indexes.map(i => i.name)
    expect(idxNames).toContain("idx_demands_status")
    expect(idxNames).toContain("idx_demands_priority")
    expect(idxNames).toContain("idx_demands_created_at")
  })

  it("is idempotent — schema can be applied twice", () => {
    schemaDb = new Database(":memory:")
    schemaDb.pragma("foreign_keys = ON")
    applySchema(schemaDb)
    expect(() => applySchema(schemaDb)).not.toThrow()

    const count = (schemaDb.prepare("SELECT COUNT(*) as cnt FROM demands").get() as { cnt: number }).cnt
    expect(count).toBe(0)
  })
})
