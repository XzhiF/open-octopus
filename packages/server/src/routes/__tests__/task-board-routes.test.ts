import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { DemandDAO } from "../../db/dao/demand-dao"
import { DemandService } from "../../services/task-board/demand-service"
import { createTaskBoardRoutes } from "../task-board"

/**
 * Integration tests for task-board REST API routes.
 * Tests all 12 endpoints with real DB and service layer.
 */
describe("Task-Board Routes", () => {
  let db: Database.Database
  let dao: DemandDAO
  let service: DemandService
  let app: ReturnType<typeof createTaskBoardRoutes>

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new DemandDAO(db)
    service = new DemandService(dao)
    app = createTaskBoardRoutes(service, dao)
  })

  afterEach(() => {
    db.close()
  })

  // Helper to create a valid demand
  const createTestDemand = (overrides = {}) => ({
    title: "Test Demand",
    description: "Test description",
    project_ids: ["proj-1"],
    demand_workflow_ref: "wf-main",
    priority: "normal" as const,
    ...overrides,
  })

  // ── #1 GET /demands — list ─────────────────────────────────────────

  describe("GET /demands", () => {
    it("returns empty list when no demands exist", async () => {
      const res = await app.request("/demands")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demands).toEqual([])
      expect(data.total).toBe(0)
    })

    it("returns demands after creation", async () => {
      // Create 2 demands
      await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ title: "First" })),
      })
      await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ title: "Second" })),
      })

      const res = await app.request("/demands")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demands.length).toBe(2)
      expect(data.total).toBe(2)
    })

    it("filters by status", async () => {
      // Create demand and transition to discussing
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      // Transition draft → discussing
      dao.updateStatus(id, "discussing")

      const res = await app.request("/demands?status=discussing")
      const data = await res.json() as any
      expect(data.demands.length).toBe(1)
      expect(data.demands[0].status).toBe("discussing")
    })

    it("filters by priority", async () => {
      await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ priority: "critical" })),
      })
      await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ priority: "low" })),
      })

      const res = await app.request("/demands?priority=critical")
      const data = await res.json() as any
      expect(data.demands.length).toBe(1)
      expect(data.demands[0].priority).toBe("critical")
    })

    it("supports pagination", async () => {
      // Create 5 demands
      for (let i = 0; i < 5; i++) {
        await app.request("/demands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTestDemand({ title: `Demand ${i}` })),
        })
      }

      const res = await app.request("/demands?page=1&pageSize=2")
      const data = await res.json() as any
      expect(data.demands.length).toBe(2)
      expect(data.total).toBe(5)
    })
  })

  // ── #2 POST /demands — create ──────────────────────────────────────

  describe("POST /demands", () => {
    it("creates a new demand and returns 201", async () => {
      const res = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })

      expect(res.status).toBe(201)
      const data = await res.json() as any
      expect(data.demand).toBeDefined()
      expect(data.demand.title).toBe("Test Demand")
      expect(data.demand.status).toBe("draft")
      expect(data.demand.id).toBeDefined()
    })

    it("returns 400 for invalid input (missing title)", async () => {
      const res = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "no title" }),
      })

      expect(res.status).toBe(400)
      const data = await res.json() as any
      expect(data.error.code).toBe("VALIDATION_ERROR")
    })

    it("returns 400 for invalid priority", async () => {
      const res = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ priority: "invalid" })),
      })

      expect(res.status).toBe(400)
    })

    it("persists demand to DB (cross-validation)", async () => {
      const res = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ title: "DB Cross-Validate" })),
      })
      const data = await res.json() as any
      const id = data.demand.id

      // Verify in DB directly
      const row = dao.findById(id)
      expect(row).not.toBeNull()
      expect(row!.title).toBe("DB Cross-Validate")
    })
  })

  // ── #3 GET /demands/:id — get by ID ────────────────────────────────

  describe("GET /demands/:id", () => {
    it("returns 200 with demand when found", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      const res = await app.request(`/demands/${id}`)
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demand.id).toBe(id)
    })

    it("returns 404 when demand not found", async () => {
      const res = await app.request("/demands/non-existent-id")
      expect(res.status).toBe(404)
      const data = await res.json() as any
      expect(data.error.code).toBe("NOT_FOUND")
    })
  })

  // ── #4 PATCH /demands/:id — update ─────────────────────────────────

  describe("PATCH /demands/:id", () => {
    it("updates allowed fields", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      const res = await app.request(`/demands/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated Title", priority: "high" }),
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demand.title).toBe("Updated Title")
      expect(data.demand.priority).toBe("high")
    })

    it("returns 404 for non-existent demand", async () => {
      const res = await app.request("/demands/non-existent-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "test" }),
      })
      expect(res.status).toBe(404)
    })

    it("returns 400 for invalid priority", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      const res = await app.request(`/demands/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "invalid" }),
      })
      expect(res.status).toBe(400)
    })
  })

  // ── #5 DELETE /demands/:id — delete ────────────────────────────────

  describe("DELETE /demands/:id", () => {
    it("deletes demand and returns success", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      const res = await app.request(`/demands/${id}`, { method: "DELETE" })
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.success).toBe(true)

      // Verify deletion
      const getRes = await app.request(`/demands/${id}`)
      expect(getRes.status).toBe(404)
    })

    it("DB cross-validation: row is removed", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      await app.request(`/demands/${id}`, { method: "DELETE" })

      // Verify directly in DAO
      const row = dao.findById(id)
      expect(row).toBeNull()
    })
  })

  // ── #6 POST /demands/:id/ready — markReady ─────────────────────────

  describe("POST /demands/:id/ready", () => {
    it("transitions incubated → ready", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      // Transition to incubated first
      dao.updateStatus(id, "discussing")
      dao.updateStatus(id, "incubated")

      const res = await app.request(`/demands/${id}/ready`, { method: "POST" })
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demand.status).toBe("ready")
    })

    it("sets ready_at timestamp (DB cross-validation)", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      dao.updateStatus(id, "discussing")
      dao.updateStatus(id, "incubated")

      await app.request(`/demands/${id}/ready`, { method: "POST" })

      // Verify in DB
      const row = dao.findById(id)
      expect(row!.status).toBe("ready")
      expect(row!.ready_at).not.toBeNull()
    })

    it("returns 422 for invalid transition (draft → ready)", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      // Demand is in draft, try to mark ready directly
      const res = await app.request(`/demands/${id}/ready`, { method: "POST" })
      expect(res.status).toBe(422)
      const data = await res.json() as any
      expect(data.error.code).toBe("INVALID_TRANSITION")
    })

    it("returns 404 for non-existent demand", async () => {
      const res = await app.request("/demands/non-existent-id/ready", { method: "POST" })
      expect(res.status).toBe(404)
    })
  })

  // ── #7 POST /demands/:id/retry — retry ─────────────────────────────

  describe("POST /demands/:id/retry", () => {
    it("transitions failed → ready and clears error", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      // Transition to failed state
      dao.updateStatus(id, "discussing")
      dao.updateStatus(id, "incubated")
      dao.updateStatus(id, "ready")
      dao.updateStatus(id, "dispatched")
      dao.updateStatus(id, "executing")
      dao.updateStatus(id, "failed")
      dao.setError(id, "Something went wrong")

      const res = await app.request(`/demands/${id}/retry`, { method: "POST" })
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demand.status).toBe("ready")
      expect(data.demand.error_message).toBeNull()
    })

    it("DB cross-validation: error_message is null after retry", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      // Get to failed state
      dao.updateStatus(id, "discussing")
      dao.updateStatus(id, "incubated")
      dao.updateStatus(id, "ready")
      dao.updateStatus(id, "dispatched")
      dao.updateStatus(id, "executing")
      dao.updateStatus(id, "failed")
      dao.setError(id, "Error message")

      await app.request(`/demands/${id}/retry`, { method: "POST" })

      // Verify in DB
      const row = dao.findById(id)
      expect(row!.status).toBe("ready")
      expect(row!.error_message).toBeNull()
    })

    it("returns 422 for invalid transition (draft → ready via retry)", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      // Demand is in draft, retry only works from failed
      const res = await app.request(`/demands/${id}/retry`, { method: "POST" })
      expect(res.status).toBe(422)
    })
  })

  // ── #8 GET /demands/:id/chat — stub ────────────────────────────────

  describe("GET /demands/:id/chat", () => {
    it("returns empty messages array", async () => {
      const res = await app.request("/demands/some-id/chat")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.messages).toEqual([])
    })
  })

  // ── #9 POST /demands/:id/chat — stub echo ──────────────────────────

  describe("POST /demands/:id/chat", () => {
    it("returns 201 with echoed message", async () => {
      const res = await app.request("/demands/test-id/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello", role: "user" }),
      })

      expect(res.status).toBe(201)
      const data = await res.json() as any
      expect(data.message).toBeDefined()
      expect(data.message.content).toBe("Hello")
      expect(data.message.demand_id).toBe("test-id")
      expect(data.message.role).toBe("user")
    })
  })

  // ── #10 GET /demands/:id/execution — stub ──────────────────────────

  describe("GET /demands/:id/execution", () => {
    it("returns execution status and empty logs", async () => {
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand()),
      })
      const created = await createRes.json() as any
      const id = created.demand.id

      const res = await app.request(`/demands/${id}/execution`)
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.status).toBe("draft")
      expect(data.logs).toEqual([])
    })

    it("returns 'unknown' status for non-existent demand", async () => {
      const res = await app.request("/demands/non-existent-id/execution")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.status).toBe("unknown")
    })
  })

  // ── #11 GET /pool/status — countByStatus ───────────────────────────

  describe("GET /pool/status", () => {
    it("returns empty counts when no demands exist", async () => {
      const res = await app.request("/pool/status")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(typeof data).toBe("object")
    })

    it("returns accurate counts by status", async () => {
      // Create 3 demands
      for (let i = 0; i < 3; i++) {
        await app.request("/demands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTestDemand({ title: `Demand ${i}` })),
        })
      }

      // Transition one to discussing
      const listRes = await app.request("/demands")
      const listData = await listRes.json() as any
      const firstId = listData.demands[0].id
      dao.updateStatus(firstId, "discussing")

      const res = await app.request("/pool/status")
      const data = await res.json() as any
      expect(data.draft).toBe(2)
      expect(data.discussing).toBe(1)
    })
  })

  // ── #12 GET /pool/queue — listReady ────────────────────────────────

  describe("GET /pool/queue", () => {
    it("returns empty list when no ready demands", async () => {
      const res = await app.request("/pool/queue")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.demands).toEqual([])
    })

    it("returns ready demands ordered by priority", async () => {
      // Create demands with different priorities
      const lowRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ title: "Low", priority: "low" })),
      })
      const criticalRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ title: "Critical", priority: "critical" })),
      })

      // Get IDs
      const lowData = await lowRes.json() as any
      const criticalData = await criticalRes.json() as any

      // Transition both to ready
      const transitionToReady = (id: string) => {
        dao.updateStatus(id, "discussing")
        dao.updateStatus(id, "incubated")
        dao.updateStatus(id, "ready")
      }
      transitionToReady(lowData.demand.id)
      transitionToReady(criticalData.demand.id)

      const res = await app.request("/pool/queue")
      const data = await res.json() as any
      expect(data.demands.length).toBe(2)
      // Critical should come first
      expect(data.demands[0].priority).toBe("critical")
      expect(data.demands[1].priority).toBe("low")
    })
  })

  // ── Full CRUD lifecycle test ───────────────────────────────────────

  describe("Full CRUD lifecycle", () => {
    it("create → get → update → delete → verify gone", async () => {
      // CREATE
      const createRes = await app.request("/demands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTestDemand({ title: "Lifecycle Test" })),
      })
      expect(createRes.status).toBe(201)
      const created = await createRes.json() as any
      const id = created.demand.id

      // READ
      const getRes = await app.request(`/demands/${id}`)
      expect(getRes.status).toBe(200)
      const gotten = await getRes.json() as any
      expect(gotten.demand.title).toBe("Lifecycle Test")

      // UPDATE
      const updateRes = await app.request(`/demands/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated Lifecycle" }),
      })
      expect(updateRes.status).toBe(200)
      const updated = await updateRes.json() as any
      expect(updated.demand.title).toBe("Updated Lifecycle")

      // DELETE
      const deleteRes = await app.request(`/demands/${id}`, { method: "DELETE" })
      expect(deleteRes.status).toBe(200)

      // VERIFY GONE
      const verifyRes = await app.request(`/demands/${id}`)
      expect(verifyRes.status).toBe(404)
    })
  })
})
