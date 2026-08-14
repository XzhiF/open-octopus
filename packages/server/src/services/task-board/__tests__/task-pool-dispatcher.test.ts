import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import { DemandDAO } from "../../../db/dao/demand-dao"
import type { DemandRow } from "../../../db/types"
import { TaskPoolDispatcher } from "../task-pool-dispatcher"

let db: Database.Database
let dao: DemandDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-dispatcher-${Date.now()}.db`)
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

/**
 * Insert a demand directly in 'ready' status for dispatcher testing.
 */
function insertReady(id: string, priority = "normal"): void {
  const now = new Date().toISOString()
  dao.insert(
    makeDemand({
      id,
      status: "ready",
      priority,
      ready_at: now,
      created_at: now,
    }),
  )
}

describe("TaskPoolDispatcher", () => {
  describe("poll()", () => {
    it("returns empty result when no ready demands exist", async () => {
      const dispatcher = new TaskPoolDispatcher(dao)

      const result = await dispatcher.poll()

      expect(result.dispatched).toEqual([])
      expect(result.count).toBe(0)

      // DB verification: no demands should have status 'dispatched'
      const counts = dao.countByStatus()
      expect(counts.dispatched).toBeUndefined()
    })

    it("marks ready demands as dispatched and returns their IDs", async () => {
      insertReady("d1")
      insertReady("d2")
      insertReady("d3")
      const dispatcher = new TaskPoolDispatcher(dao)

      const result = await dispatcher.poll()

      expect(result.count).toBe(3)
      expect(result.dispatched).toHaveLength(3)
      expect(result.dispatched).toContain("d1")
      expect(result.dispatched).toContain("d2")
      expect(result.dispatched).toContain("d3")

      // DB verification: all demands should now be 'dispatched'
      for (const id of ["d1", "d2", "d3"]) {
        const row = dao.findById(id)
        expect(row).not.toBeNull()
        expect(row!.status).toBe("dispatched")
        expect(row!.dispatched_at).not.toBeNull()
      }
    })

    it("respects batch_size limit — 10 ready, batch=5 → only 5 dispatched", async () => {
      for (let i = 0; i < 10; i++) {
        insertReady(`d-${i}`)
      }
      const dispatcher = new TaskPoolDispatcher(dao, 5)

      const result = await dispatcher.poll()

      expect(result.count).toBe(5)
      expect(result.dispatched).toHaveLength(5)

      // DB verification: exactly 5 dispatched, 5 still ready
      const counts = dao.countByStatus()
      expect(counts.dispatched).toBe(5)
      expect(counts.ready).toBe(5)
    })

    it("dispatches critical demands before normal (priority ordering)", async () => {
      insertReady("d-normal", "normal")
      insertReady("d-critical", "critical")
      insertReady("d-low", "low")
      insertReady("d-high", "high")
      const dispatcher = new TaskPoolDispatcher(dao, 2)

      const result = await dispatcher.poll()

      // Only top 2 by priority should be dispatched: critical, high
      expect(result.count).toBe(2)
      expect(result.dispatched).toContain("d-critical")
      expect(result.dispatched).toContain("d-high")

      // DB verification: critical and high dispatched, normal and low still ready
      expect(dao.findById("d-critical")!.status).toBe("dispatched")
      expect(dao.findById("d-high")!.status).toBe("dispatched")
      expect(dao.findById("d-normal")!.status).toBe("ready")
      expect(dao.findById("d-low")!.status).toBe("ready")
    })

    it("does not affect non-ready demands", async () => {
      // Insert a mix of statuses
      dao.insert(makeDemand({ id: "d-draft", status: "draft" }))
      dao.insert(makeDemand({ id: "d-done", status: "done" }))
      insertReady("d-ready")
      const dispatcher = new TaskPoolDispatcher(dao)

      const result = await dispatcher.poll()

      expect(result.count).toBe(1)
      expect(result.dispatched).toEqual(["d-ready"])

      // DB verification: draft and done unchanged
      expect(dao.findById("d-draft")!.status).toBe("draft")
      expect(dao.findById("d-done")!.status).toBe("done")
    })
  })

  describe("execute()", () => {
    it("happy path: dispatched → executing → done with result", async () => {
      insertReady("d1")
      dao.updateStatus("d1", "dispatched")
      const dispatcher = new TaskPoolDispatcher(dao)

      await dispatcher.execute("d1")

      // DB verification: status should be 'done'
      const row = dao.findById("d1")
      expect(row).not.toBeNull()
      expect(row!.status).toBe("done")
      expect(row!.completed_at).not.toBeNull()
      expect(row!.result).toBe("Completed (R2 stub)")
    })

    it("failure path: dispatched → executing → failed with error_message", async () => {
      insertReady("d1")
      dao.updateStatus("d1", "dispatched")
      const dispatcher = new TaskPoolDispatcher(dao)

      // Force a failure by using a spy that throws on update
      const originalUpdate = dao.update.bind(dao)
      let callCount = 0
      dao.update = (id: string, fields: Partial<DemandRow>) => {
        callCount++
        // Fail on the first update call (the result update after done)
        throw new Error("Simulated execution failure")
      }

      await dispatcher.execute("d1")

      // DB verification: status should be 'failed' with error message
      const row = dao.findById("d1")
      expect(row).not.toBeNull()
      expect(row!.status).toBe("failed")
      expect(row!.completed_at).not.toBeNull()
      expect(row!.error_message).toContain("Simulated execution failure")

      // Restore
      dao.update = originalUpdate
    })

    it("skips execution when demand does not exist", async () => {
      const dispatcher = new TaskPoolDispatcher(dao)

      // Should not throw
      await dispatcher.execute("nonexistent")
    })

    it("skips execution when demand is not in dispatched status", async () => {
      dao.insert(makeDemand({ id: "d1", status: "ready" }))
      const dispatcher = new TaskPoolDispatcher(dao)

      await dispatcher.execute("d1")

      // DB verification: status should still be 'ready', untouched
      const row = dao.findById("d1")
      expect(row!.status).toBe("ready")
    })
  })

  describe("integration: poll → execute flow", () => {
    it("full flow: create ready demands → poll → execute → verify DB", async () => {
      // Set up: 3 ready demands with different priorities
      insertReady("d-critical", "critical")
      insertReady("d-normal", "normal")
      insertReady("d-low", "low")
      const dispatcher = new TaskPoolDispatcher(dao, 2)

      // Step 1: Poll — should pick top 2 by priority
      const pollResult = await dispatcher.poll()
      expect(pollResult.count).toBe(2)
      expect(pollResult.dispatched).toContain("d-critical")
      expect(pollResult.dispatched).toContain("d-normal")

      // DB check after poll
      expect(dao.findById("d-critical")!.status).toBe("dispatched")
      expect(dao.findById("d-normal")!.status).toBe("dispatched")
      expect(dao.findById("d-low")!.status).toBe("ready")

      // Step 2: Execute each dispatched demand
      for (const id of pollResult.dispatched) {
        await dispatcher.execute(id)
      }

      // DB check after execute: both should be 'done'
      expect(dao.findById("d-critical")!.status).toBe("done")
      expect(dao.findById("d-critical")!.result).toBe("Completed (R2 stub)")
      expect(dao.findById("d-critical")!.completed_at).not.toBeNull()

      expect(dao.findById("d-normal")!.status).toBe("done")
      expect(dao.findById("d-normal")!.result).toBe("Completed (R2 stub)")

      // d-low should still be ready
      expect(dao.findById("d-low")!.status).toBe("ready")
    })

    it("second poll picks up remaining demands after first batch", async () => {
      for (let i = 0; i < 6; i++) {
        insertReady(`d-${i}`)
      }
      const dispatcher = new TaskPoolDispatcher(dao, 3)

      // First poll
      const first = await dispatcher.poll()
      expect(first.count).toBe(3)

      // Second poll — should pick up remaining 3
      const second = await dispatcher.poll()
      expect(second.count).toBe(3)

      // DB verification: all 6 should be dispatched
      const counts = dao.countByStatus()
      expect(counts.dispatched).toBe(6)
      expect(counts.ready).toBeUndefined()
    })
  })
})
