import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ArchiveDraftDAO } from "../../db/dao/archive-draft-dao"
import { createArchiveRoutes } from "../archive"
import type { PendingReviewDAO } from "../../db/dao"

// Minimal mock for PendingReviewDAO — only listBySource used in /:id/propose
const mockPendingReviewDAO = {
  listBySource: () => [],
} as unknown as PendingReviewDAO

function createTestApp(archiveDAO?: ArchiveDAO, draftDAO?: ArchiveDraftDAO) {
  return createArchiveRoutes(mockPendingReviewDAO, "/tmp/test-state-dir", archiveDAO, draftDAO)
}

describe("Archive Routes", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO
  let draftDAO: ArchiveDraftDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    archiveDAO = new ArchiveDAO(db)
    draftDAO = new ArchiveDraftDAO(db)
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
  //
  // NOTE: The old dashboard endpoints (/stats, /cost-trends, /workflow-stats,
  // /leaderboard) and their param-validation cases were removed in
  // 17a70a42 refactor(archive-v2) Phase 7 — archive stats now live on
  // /api/dashboard/stats. Their stale cases were deleted per
  // .scratch/20260927-kb-roadmap/issues/01; the read-only DAO queries
  // (getStats etc.) remain and are covered by DAO-level tests.

  describe("input validation", () => {
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

    it("rejects invalid UUID format on /workspaces/:id", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/workspaces/not-a-uuid")
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("INVALID_PARAM")
    })

    it("rejects invalid UUID format on archive-preview", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/workspaces/not-a-uuid/archive-preview", { method: "POST" })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("INVALID_PARAM")
    })
  })

  // ── Propose (state-file lookup) ───────────────────────────────────────

  describe("/:id/propose", () => {
    it("returns 404 when execution state file is missing", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/550e8400-e29b-41d4-a716-4466554400fe/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: "test" }),
      })
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error.code).toBe("NOT_FOUND")
    })
  })

  // ── SUBSYSTEM_UNAVAILABLE (503) — live endpoints ──────────────────────

  describe("subsystem unavailable", () => {
    it("returns 503 on /workspaces/:id when archiveDAO missing", async () => {
      const app = createTestApp(undefined)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400ff")
      expect(res.status).toBe(503)
      const data = await res.json()
      expect(data.error.code).toBe("SUBSYSTEM_UNAVAILABLE")
    })

    it("returns 503 on GET archive-draft when draftDAO missing", async () => {
      const app = createTestApp(archiveDAO, undefined)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400ff/archive-draft")
      expect(res.status).toBe(503)
      const data = await res.json()
      expect(data.error.code).toBe("SUBSYSTEM_UNAVAILABLE")
    })

    it("returns 503 on DELETE archive-draft when draftDAO missing", async () => {
      const app = createTestApp(archiveDAO, undefined)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400ff/archive-draft", {
        method: "DELETE",
      })
      expect(res.status).toBe(503)
    })
  })

  // ── Archived workspace lookup ─────────────────────────────────────────

  describe("GET /workspaces/:id", () => {
    it("returns 404 for non-archived workspace", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400aa")
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error.code).toBe("NOT_FOUND")
    })

    it("returns the archived workspace row", async () => {
      archiveDAO.insertWorkspaceArchive({
        workspace_id: "550e8400-e29b-41d4-a716-4466554400ab",
        org: "test",
        name: "demo-ws",
        description: null,
        source: null,
        execution_count: 3,
        total_cost: 0.42,
        total_duration_ms: 1234,
        created_at: 100,
        archived_at: 200,
        metadata: null,
        extracted_experiences: 1,
        extracted_skills: 0,
        extracted_workflows: 0,
        extracted_agents: 0,
        analysis_report: null,
        file_deleted: 0,
      } as any)

      const app = createTestApp(archiveDAO)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400ab")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.workspace_id).toBe("550e8400-e29b-41d4-a716-4466554400ab")
      expect(data.name).toBe("demo-ws")
      expect(data.execution_count).toBe(3)
    })
  })

  // ── Draft lookup ──────────────────────────────────────────────────────

  describe("GET /workspaces/:id/archive-draft", () => {
    it("returns { draft: null } when no draft exists", async () => {
      const app = createTestApp(archiveDAO, draftDAO)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400ac/archive-draft")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.draft).toBeNull()
    })

    it("returns the parsed draft when present", async () => {
      draftDAO.upsert({
        workspace_id: "550e8400-e29b-41d4-a716-4466554400ad",
        org: "test",
        analysis_report: JSON.stringify({ summary: "ok" }),
        experiences: JSON.stringify([]),
        skills: JSON.stringify([]),
        stats: JSON.stringify({ tokens: 10 }),
      } as any)

      const app = createTestApp(archiveDAO, draftDAO)
      const res = await app.request("/workspaces/550e8400-e29b-41d4-a716-4466554400ad/archive-draft")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.draft.workspace_id).toBe("550e8400-e29b-41d4-a716-4466554400ad")
      expect(data.draft.analysis_report).toEqual({ summary: "ok" })
      expect(data.draft.stats).toEqual({ tokens: 10 })
    })
  })

  // ── Skill groups ──────────────────────────────────────────────────────

  describe("GET /skill-groups", () => {
    it("always includes archive-extracted group in each type list", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/skill-groups")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.skillGroups).toContain("archive-extracted")
      expect(data.workflowGroups).toContain("archive-extracted")
      expect(data.agentGroups).toContain("archive-extracted")
    })
  })

  // ── Summary 404 ───────────────────────────────────────────────────────

  describe("summary", () => {
    it("returns 404 for non-existent execution summary", async () => {
      const app = createTestApp(archiveDAO)
      const res = await app.request("/550e8400-e29b-41d4-a716-446655440099/summary")
      expect(res.status).toBe(404)
    })
  })
})
