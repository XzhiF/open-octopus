import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { createArchiveRoutes } from "../archive"
import type { PendingReviewDAO } from "../../db/dao"

// Minimal mock for PendingReviewDAO — only listBySource used in /:id/propose
const mockPendingReviewDAO = {
  listBySource: () => [],
} as unknown as PendingReviewDAO

function createTestApp(archiveDAO?: ArchiveDAO) {
  return createArchiveRoutes(mockPendingReviewDAO, "/tmp/test-state-dir", archiveDAO)
}

describe("Archive Routes", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    archiveDAO = new ArchiveDAO(db)
  })

  afterEach(() => {
    db.close()
  })

  // ── sanitizePoolSnapshot ──────────────────────────────────────────────

  describe("sanitizePoolSnapshot", () => {
    it("redacts keys matching secret patterns", async () => {
      const fs = await import("fs")
      const stateDir = "/tmp/test-archive-routes"
      const execId = "550e8400-e29b-41d4-a716-446655440000"
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(
        `${stateDir}/${execId}.json`,
        JSON.stringify({
          nodes: {},
          poolSnapshot: {
            api_key: "sk-secret-123",
            password: "hunter2",
            auth_token: "tok-abc",
            private_key: "-----BEGIN RSA",
            normal_value: "safe-data",
            count: 42,
          },
        }),
      )

      const app = createArchiveRoutes(mockPendingReviewDAO, stateDir, archiveDAO)
      const res = await app.request(`/${execId}/summary`)
      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data.poolSnapshot.api_key).toBe("[REDACTED]")
      expect(data.poolSnapshot.password).toBe("[REDACTED]")
      expect(data.poolSnapshot.auth_token).toBe("[REDACTED]")
      expect(data.poolSnapshot.private_key).toBe("[REDACTED]")
      expect(data.poolSnapshot.normal_value).toBe("safe-data")
      expect(data.poolSnapshot.count).toBe(42)

      fs.unlinkSync(`${stateDir}/${execId}.json`)
      fs.rmdirSync(stateDir)
    })

    it("returns null poolSnapshot when missing", async () => {
      const fs = await import("fs")
      const stateDir = "/tmp/test-archive-routes-2"
      const execId = "550e8400-e29b-41d4-a716-446655440001"
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(`${stateDir}/${execId}.json`, JSON.stringify({ nodes: {} }))

      const app = createArchiveRoutes(mockPendingReviewDAO, stateDir, archiveDAO)
      const res = await app.request(`/${execId}/summary`)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.poolSnapshot).toBeNull()

      fs.unlinkSync(`${stateDir}/${execId}.json`)
      fs.rmdirSync(stateDir)
    })
  })

  // ── Input validation ──────────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects invalid period on /cost-trends", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/cost-trends?org=test&period=invalid")
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("INVALID_PARAM")
    })

    it("rejects invalid metric on /leaderboard", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/leaderboard?org=test&metric=invalid")
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("INVALID_PARAM")
    })

    it("clamps NaN limit to default 10 on /leaderboard", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/leaderboard?org=test&limit=abc")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.limit).toBe(10)
    })

    it("clamps limit to [1,50] range on /leaderboard", async () => {
      const app = createTestApp(archiveDAO)

      const res0 = await app.request("/leaderboard?org=test&limit=0")
      const data0 = await res0.json()
      expect(data0.limit).toBe(1)

      const res100 = await app.request("/leaderboard?org=test&limit=100")
      const data100 = await res100.json()
      expect(data100.limit).toBe(50)
    })

    it("rejects invalid UUID format on /:id/summary", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/not-a-uuid/summary")
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("INVALID_PARAM")
    })

    it("rejects path traversal on /:id/propose", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/not-valid-uuid/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: "test" }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("INVALID_PARAM")
    })
  })

  // ── SUBSYSTEM_UNAVAILABLE (503) ────────────────────────────────────────

  describe("subsystem unavailable", () => {
    it("returns 503 on /stats when archiveDAO missing", async () => {
      const app = createTestApp(undefined)
      const res = await app.request("/stats")
      expect(res.status).toBe(503)
      const data = await res.json()
      expect(data.error.code).toBe("SUBSYSTEM_UNAVAILABLE")
    })

    it("returns 503 on /cost-trends when archiveDAO missing", async () => {
      const app = createTestApp(undefined)
      const res = await app.request("/cost-trends?org=test")
      expect(res.status).toBe(503)
    })

    it("returns 503 on /workflow-stats when archiveDAO missing", async () => {
      const app = createTestApp(undefined)
      const res = await app.request("/workflow-stats")
      expect(res.status).toBe(503)
    })

    it("returns 503 on /leaderboard when archiveDAO missing", async () => {
      const app = createTestApp(undefined)
      const res = await app.request("/leaderboard?org=test")
      expect(res.status).toBe(503)
    })
  })

  // ── Dashboard endpoints with real DAO ──────────────────────────────────

  describe("dashboard endpoints", () => {
    it("returns empty stats for fresh database", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/stats?org=test")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.total_executions).toBe(0)
      expect(data.total_cost).toBe(0)
    })

    it("returns empty cost-trends for fresh database", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/cost-trends?org=test&period=7d")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.period).toBe("7d")
      expect(data.data).toEqual([])
    })

    it("returns 404 for non-existent execution summary", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/550e8400-e29b-41d4-a716-446655440099/summary")
      expect(res.status).toBe(404)
    })
  })
})
