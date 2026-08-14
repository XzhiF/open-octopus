import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import { DemandDAO } from "../../../db/dao/demand-dao"
import type { DemandRow } from "../../../db/types"
import {
  DemandService,
  InvalidTransitionError,
  DemandNotFoundError,
} from "../demand-service"
import {
  demandSchema,
  createDemandInputSchema,
  type CreateDemandInput,
  type DemandStatus,
} from "@octopus/shared"

let db: Database.Database
let dao: DemandDAO
let service: DemandService
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-demand-service-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new DemandDAO(db)
  service = new DemandService(dao)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

/**
 * Helper to seed a demand directly into the DB with a known status.
 */
function seedDemand(overrides: Partial<DemandRow> = {}): DemandRow {
  const now = new Date().toISOString()
  const row: DemandRow = {
    id: `demand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test demand",
    description: "A test demand",
    status: "draft",
    priority: "normal",
    project_ids: '["project-1"]',
    demand_workflow_ref: "spec-forge",
    exec_workflow_chain: '[]',
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
  dao.insert(row)
  return row
}

/**
 * Helper to advance a demand through the lifecycle to a target status.
 */
function advanceToStatus(targetStatus: DemandStatus): string {
  const path: DemandStatus[] = [
    "draft", "discussing", "incubated", "ready", "dispatched", "executing", "done",
  ]
  const targetIdx = path.indexOf(targetStatus)
  if (targetIdx === -1) throw new Error(`Cannot advance to ${targetStatus} via linear path`)

  const row = seedDemand({ status: "draft" })
  for (let i = 1; i <= targetIdx; i++) {
    dao.updateStatus(row.id, path[i])
  }
  return row.id
}

// ─── create() ───────────────────────────────────────────────────────

describe("DemandService", () => {
  describe("create()", () => {
    it("AC1: creates a demand with valid input, returns Zod-valid Demand", () => {
      const input: CreateDemandInput = {
        title: "New feature demand",
        description: "Build something cool",
        project_ids: ["project-1"],
        demand_workflow_ref: "spec-forge",
        priority: "high",
      }

      const result = service.create(input)

      // Validate the return matches Zod schema
      const parsed = demandSchema.safeParse(result)
      expect(parsed.success).toBe(true)

      // Verify field values
      expect(result.title).toBe("New feature demand")
      expect(result.description).toBe("Build something cool")
      expect(result.status).toBe("draft")
      expect(result.priority).toBe("high")
      expect(result.project_ids).toEqual(["project-1"])
      expect(result.demand_workflow_ref).toBe("spec-forge")
      expect(result.id).toBeTruthy()
      expect(result.created_at).toBeTruthy()
    })

    it("AC6: round-trip — Zod validate → DAO insert → DB read → Zod validate", () => {
      const input: CreateDemandInput = {
        title: "Round-trip test",
        project_ids: ["p1", "p2"],
        demand_workflow_ref: "wf-1",
        exec_workflow_chain: [{ workflow_ref: "exec-1", input_values: { key: "val" } }],
        priority: "critical",
      }

      // Step 1: Zod validate input
      const validatedInput = createDemandInputSchema.parse(input)
      expect(validatedInput.title).toBe("Round-trip test")

      // Step 2: Create via service (inserts into DB)
      const created = service.create(validatedInput)

      // Step 3: Read back from DB via service
      const fetched = service.getById(created.id)
      expect(fetched).not.toBeNull()

      // Step 4: Zod validate the fetched result
      const parsed = demandSchema.safeParse(fetched)
      expect(parsed.success).toBe(true)
      expect(parsed.data!.title).toBe("Round-trip test")
      expect(parsed.data!.priority).toBe("critical")
      expect(parsed.data!.project_ids).toEqual(["p1", "p2"])
    })

    it("rejects invalid input (empty title)", () => {
      const input = {
        title: "",
        project_ids: ["p1"],
        demand_workflow_ref: "wf-1",
      }

      expect(() => service.create(input as CreateDemandInput)).toThrow()
    })

    it("rejects invalid input (missing project_ids)", () => {
      const input = {
        title: "Valid title",
        project_ids: [],
        demand_workflow_ref: "wf-1",
      }

      expect(() => service.create(input as CreateDemandInput)).toThrow()
    })

    it("rejects invalid priority", () => {
      const input = {
        title: "Valid title",
        project_ids: ["p1"],
        demand_workflow_ref: "wf-1",
        priority: "invalid-priority",
      }

      expect(() => service.create(input as CreateDemandInput)).toThrow()
    })

    it("generates unique IDs for each demand", () => {
      const input: CreateDemandInput = {
        title: "Duplicate test",
        project_ids: ["p1"],
        demand_workflow_ref: "wf-1",
      }

      const d1 = service.create(input)
      const d2 = service.create(input)
      expect(d1.id).not.toBe(d2.id)
    })
  })

  // ─── getById() ──────────────────────────────────────────────────────

  describe("getById()", () => {
    it("returns demand when found", () => {
      const row = seedDemand({ id: "get-by-id-test", title: "Find me" })
      const result = service.getById("get-by-id-test")
      expect(result).not.toBeNull()
      expect(result!.id).toBe("get-by-id-test")
      expect(result!.title).toBe("Find me")
    })

    it("returns null for non-existent demand", () => {
      const result = service.getById("does-not-exist")
      expect(result).toBeNull()
    })
  })

  // ─── list() ─────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns paginated results", () => {
      seedDemand({ id: "l1" })
      seedDemand({ id: "l2" })
      seedDemand({ id: "l3" })

      const result = service.list({}, 1, 2)
      expect(result.data.length).toBe(2)
      expect(result.total).toBe(3)
    })

    it("filters by status", () => {
      seedDemand({ id: "ls1", status: "draft" })
      seedDemand({ id: "ls2", status: "ready" })
      seedDemand({ id: "ls3", status: "draft" })

      const result = service.list({ status: "draft" })
      expect(result.total).toBe(2)
      expect(result.data.every((d) => d.status === "draft")).toBe(true)
    })

    it("filters by priority", () => {
      seedDemand({ id: "lp1", priority: "high" })
      seedDemand({ id: "lp2", priority: "low" })
      seedDemand({ id: "lp3", priority: "high" })

      const result = service.list({ priority: "high" })
      expect(result.total).toBe(2)
      expect(result.data.every((d) => d.priority === "high")).toBe(true)
    })
  })

  // ─── updateStatus() — Valid transitions (AC2) ──────────────────────

  describe("updateStatus() — valid transitions (AC2)", () => {
    it("draft → discussing", () => {
      const row = seedDemand({ status: "draft" })
      const result = service.updateStatus(row.id, "discussing")

      // Verify DB state
      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("discussing")
      expect(result.status).toBe("discussing")
    })

    it("discussing → incubated", () => {
      const row = seedDemand({ status: "discussing" })
      const result = service.updateStatus(row.id, "incubated")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("incubated")
      expect(result.status).toBe("incubated")
    })

    it("incubated → ready", () => {
      const row = seedDemand({ status: "incubated" })
      const result = service.updateStatus(row.id, "ready")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("ready")
      expect(fromDb.ready_at).not.toBeNull()
      expect(result.status).toBe("ready")
    })

    it("ready → dispatched", () => {
      const row = seedDemand({ status: "ready" })
      const result = service.updateStatus(row.id, "dispatched")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("dispatched")
      expect(fromDb.dispatched_at).not.toBeNull()
      expect(result.status).toBe("dispatched")
    })

    it("dispatched → executing", () => {
      const row = seedDemand({ status: "dispatched" })
      const result = service.updateStatus(row.id, "executing")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("executing")
      expect(result.status).toBe("executing")
    })

    it("executing → done", () => {
      const row = seedDemand({ status: "executing" })
      const result = service.updateStatus(row.id, "done")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("done")
      expect(fromDb.completed_at).not.toBeNull()
      expect(result.status).toBe("done")
    })

    it("executing → failed", () => {
      const row = seedDemand({ status: "executing" })
      const result = service.updateStatus(row.id, "failed")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("failed")
      expect(fromDb.completed_at).not.toBeNull()
      expect(result.status).toBe("failed")
    })

    it("failed → ready (retry)", () => {
      const row = seedDemand({ status: "failed" })
      const result = service.updateStatus(row.id, "ready")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("ready")
      expect(fromDb.ready_at).not.toBeNull()
      expect(result.status).toBe("ready")
    })
  })

  // ─── updateStatus() — Invalid transitions (AC3) ───────────────────

  describe("updateStatus() — invalid transitions (AC3)", () => {
    it("draft → done throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "draft" })
      expect(() => service.updateStatus(row.id, "done")).toThrow(InvalidTransitionError)
    })

    it("draft → ready throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "draft" })
      expect(() => service.updateStatus(row.id, "ready")).toThrow(InvalidTransitionError)
    })

    it("done → draft throws InvalidTransitionError (terminal state)", () => {
      const row = seedDemand({ status: "done" })
      expect(() => service.updateStatus(row.id, "draft")).toThrow(InvalidTransitionError)
    })

    it("done → ready throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "done" })
      expect(() => service.updateStatus(row.id, "ready")).toThrow(InvalidTransitionError)
    })

    it("ready → draft throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "ready" })
      expect(() => service.updateStatus(row.id, "draft")).toThrow(InvalidTransitionError)
    })

    it("ready → done throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "ready" })
      expect(() => service.updateStatus(row.id, "done")).toThrow(InvalidTransitionError)
    })

    it("dispatched → draft throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "dispatched" })
      expect(() => service.updateStatus(row.id, "draft")).toThrow(InvalidTransitionError)
    })

    it("executing → ready throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "executing" })
      expect(() => service.updateStatus(row.id, "ready")).toThrow(InvalidTransitionError)
    })

    it("discussing → ready throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "discussing" })
      expect(() => service.updateStatus(row.id, "ready")).toThrow(InvalidTransitionError)
    })

    it("incubated → dispatched throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "incubated" })
      expect(() => service.updateStatus(row.id, "dispatched")).toThrow(InvalidTransitionError)
    })

    it("draft → failed throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "draft" })
      expect(() => service.updateStatus(row.id, "failed")).toThrow(InvalidTransitionError)
    })

    it("draft → executing throws InvalidTransitionError", () => {
      const row = seedDemand({ status: "draft" })
      expect(() => service.updateStatus(row.id, "executing")).toThrow(InvalidTransitionError)
    })

    it("descriptive error message includes current and target status", () => {
      const row = seedDemand({ status: "draft" })
      try {
        service.updateStatus(row.id, "done")
        expect.fail("Should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransitionError)
        expect((err as Error).message).toContain("draft")
        expect((err as Error).message).toContain("done")
      }
    })

    it("invalid transition does not change DB state", () => {
      const row = seedDemand({ status: "draft" })
      try {
        service.updateStatus(row.id, "done")
      } catch {
        // expected
      }
      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("draft")
    })
  })

  // ─── updateStatus() — not found ──────────────────────────────────

  describe("updateStatus() — not found", () => {
    it("throws DemandNotFoundError for non-existent demand", () => {
      expect(() => service.updateStatus("does-not-exist", "ready")).toThrow(
        DemandNotFoundError,
      )
    })
  })

  // ─── markReady() (AC4) ─────────────────────────────────────────────

  describe("markReady() (AC4)", () => {
    it("succeeds when current status is incubated", () => {
      const row = seedDemand({ status: "incubated" })
      const result = service.markReady(row.id)

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("ready")
      expect(fromDb.ready_at).not.toBeNull()
      expect(result.status).toBe("ready")
    })

    it("throws InvalidTransitionError when status is not incubated", () => {
      const row = seedDemand({ status: "draft" })
      expect(() => service.markReady(row.id)).toThrow(InvalidTransitionError)
    })

    it("throws InvalidTransitionError when status is ready (already ready)", () => {
      const row = seedDemand({ status: "ready" })
      expect(() => service.markReady(row.id)).toThrow(InvalidTransitionError)
    })

    it("throws InvalidTransitionError when status is discussing", () => {
      const row = seedDemand({ status: "discussing" })
      expect(() => service.markReady(row.id)).toThrow(InvalidTransitionError)
    })
  })

  // ─── retry() (AC5) ─────────────────────────────────────────────────

  describe("retry() (AC5)", () => {
    it("succeeds when current status is failed — sets ready and clears error", () => {
      const row = seedDemand({ status: "failed", error_message: "Something went wrong" })
      const result = service.retry(row.id)

      const fromDb = dao.findById(row.id)!
      expect(fromDb.status).toBe("ready")
      expect(fromDb.error_message).toBeNull()
      expect(fromDb.ready_at).not.toBeNull()
      expect(result.status).toBe("ready")
      expect(result.error_message).toBeNull()
    })

    it("throws InvalidTransitionError when status is not failed", () => {
      const row = seedDemand({ status: "done" })
      expect(() => service.retry(row.id)).toThrow(InvalidTransitionError)
    })

    it("throws InvalidTransitionError when status is draft", () => {
      const row = seedDemand({ status: "draft" })
      expect(() => service.retry(row.id)).toThrow(InvalidTransitionError)
    })

    it("throws InvalidTransitionError when status is executing", () => {
      const row = seedDemand({ status: "executing" })
      expect(() => service.retry(row.id)).toThrow(InvalidTransitionError)
    })
  })

  // ─── setError() ─────────────────────────────────────────────────────

  describe("setError()", () => {
    it("sets error message on a demand", () => {
      const row = seedDemand({ status: "executing" })
      service.setError(row.id, "Connection timeout")

      const fromDb = dao.findById(row.id)!
      expect(fromDb.error_message).toBe("Connection timeout")
    })

    it("clears error message when message is null", () => {
      const row = seedDemand({ status: "failed", error_message: "Previous error" })
      service.setError(row.id, null)

      const fromDb = dao.findById(row.id)!
      expect(fromDb.error_message).toBeNull()
    })
  })

  // ─── Full lifecycle integration test ──────────────────────────────

  describe("full lifecycle integration", () => {
    it("walks a demand through draft → done", () => {
      const input: CreateDemandInput = {
        title: "Full lifecycle",
        project_ids: ["p1"],
        demand_workflow_ref: "wf-1",
        priority: "high",
      }

      let demand = service.create(input)
      expect(demand.status).toBe("draft")

      demand = service.updateStatus(demand.id, "discussing")
      expect(demand.status).toBe("discussing")

      demand = service.updateStatus(demand.id, "incubated")
      expect(demand.status).toBe("incubated")

      demand = service.markReady(demand.id)
      expect(demand.status).toBe("ready")

      demand = service.updateStatus(demand.id, "dispatched")
      expect(demand.status).toBe("dispatched")

      demand = service.updateStatus(demand.id, "executing")
      expect(demand.status).toBe("executing")

      demand = service.updateStatus(demand.id, "done")
      expect(demand.status).toBe("done")

      // Verify final DB state
      const fromDb = dao.findById(demand.id)!
      expect(fromDb.status).toBe("done")
      expect(fromDb.completed_at).not.toBeNull()
      expect(fromDb.dispatched_at).not.toBeNull()
      expect(fromDb.ready_at).not.toBeNull()
    })

    it("walks a demand through draft → failed → retry → ready", () => {
      const input: CreateDemandInput = {
        title: "Retry lifecycle",
        project_ids: ["p1"],
        demand_workflow_ref: "wf-1",
      }

      let demand = service.create(input)
      demand = service.updateStatus(demand.id, "discussing")
      demand = service.updateStatus(demand.id, "incubated")
      demand = service.markReady(demand.id)
      demand = service.updateStatus(demand.id, "dispatched")
      demand = service.updateStatus(demand.id, "executing")
      demand = service.updateStatus(demand.id, "failed")
      expect(demand.status).toBe("failed")

      // Set error
      service.setError(demand.id, "Execution failed")
      let fromDb = dao.findById(demand.id)!
      expect(fromDb.error_message).toBe("Execution failed")

      // Retry
      demand = service.retry(demand.id)
      expect(demand.status).toBe("ready")
      expect(demand.error_message).toBeNull()

      fromDb = dao.findById(demand.id)!
      expect(fromDb.status).toBe("ready")
      expect(fromDb.error_message).toBeNull()
    })
  })
})
