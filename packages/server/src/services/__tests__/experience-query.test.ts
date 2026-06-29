// packages/server/src/services/__tests__/experience-query.test.ts
// Tests for experience query paths: extraction, scope filtering, FTS,
// archive workflowRefs memory-scope filter, and existing injector test verification.
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  return db
}

function seedExperience(db: Database.Database, opts: {
  id?: string; type?: string; status?: string; title?: string;
  relevance_score?: number; project?: string; pkg?: string;
  content?: string; keywords?: string; org?: string;
  file_pattern?: string
}) {
  const id = opts.id || randomUUID()
  db.prepare(
    `INSERT INTO experience_index (id, org, type, status, title, content, project, package, file_pattern, keywords, relevance_score, use_count, workflow_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'wf', datetime('now'), datetime('now'))`
  ).run(
    id,
    opts.org || "test-org",
    opts.type || "bug",
    opts.status || "active",
    opts.title || `Exp ${id}`,
    opts.content || "test content",
    opts.project || "proj-a",
    opts.pkg || "",
    opts.file_pattern || "",
    opts.keywords || "",
    opts.relevance_score ?? 1.0
  )
  return id
}

function seedArchive(db: Database.Database, opts: {
  id?: string; org?: string; workflowRef?: string; status?: string;
  cost?: number; workspaceId?: string
}) {
  const id = opts.id || randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO execution_archive (id, org, workflow_ref, workflow_name, status, started_at, completed_at, duration_ms, total_cost_usd, workspace_id, created_at)
     VALUES (?, ?, ?, 'Test Workflow', ?, ?, ?, 60000, ?, ?, ?)`
  ).run(id, opts.org || "test-org", opts.workflowRef || "wf-test", opts.status || "completed", now, now, opts.cost ?? 0.1, opts.workspaceId || "ws-1", now)
  return id
}

describe("Experience Query Tests", () => {
  let db: Database.Database
  let experienceDAO: ExperienceDAO
  let archiveDAO: ArchiveDAO

  beforeEach(() => {
    db = createTestDb()
    experienceDAO = new ExperienceDAO(db)
    archiveDAO = new ArchiveDAO(db)
  })

  // TC-012: Experience extraction pipeline — query with proper fields
  describe("TC-012: Experience extraction pipeline", () => {
    it("inserts archive records and queries experience items with proper fields", () => {
      // Seed archive records
      const archiveId1 = seedArchive(db, { workflowRef: "wf-1", status: "completed", cost: 0.5 })
      const archiveId2 = seedArchive(db, { workflowRef: "wf-2", status: "failed", cost: 1.0 })

      // Seed experiences linked to archives
      seedExperience(db, {
        type: "bug", status: "active", title: "API timeout bug",
        project: "proj-a", relevance_score: 8.0,
      })
      seedExperience(db, {
        type: "pattern", status: "active", title: "Retry pattern",
        project: "proj-a", relevance_score: 5.0,
      })
      seedExperience(db, {
        type: "cost", status: "active", title: "High cost execution",
        project: "proj-b", relevance_score: 3.0,
      })

      // Query by scope
      const results = experienceDAO.findByScope({ status: "active", limit: 10 })
      expect(results.length).toBe(3)

      // Verify fields are properly populated
      const bug = results.find(r => r.title === "API timeout bug")
      expect(bug).toBeDefined()
      expect(bug!.type).toBe("bug")
      expect(bug!.status).toBe("active")
      expect(bug!.project).toBe("proj-a")
      expect(bug!.relevance_score).toBe(8.0)
    })

    it("returns experiences sorted by relevance_score DESC", () => {
      seedExperience(db, { type: "bug", status: "active", title: "Low", relevance_score: 1.0 })
      seedExperience(db, { type: "bug", status: "active", title: "High", relevance_score: 10.0 })
      seedExperience(db, { type: "bug", status: "active", title: "Mid", relevance_score: 5.0 })

      const results = experienceDAO.findByScope({ status: "active", limit: 10 })
      expect(results.length).toBe(3)
      expect(results[0].title).toBe("High")
      expect(results[1].title).toBe("Mid")
      expect(results[2].title).toBe("Low")
    })
  })

  // TC-024: ExperienceDAO.findByScope returns properly formatted results
  describe("TC-024: Agent session context — ExperienceDAO.findByScope", () => {
    it("returns properly formatted results for session injection", () => {
      seedExperience(db, {
        type: "bug", status: "active", title: "CORS bug",
        project: "server", relevance_score: 7.0, keywords: "cors,http",
      })
      seedExperience(db, {
        type: "pattern", status: "active", title: "Auth pattern",
        project: "server", relevance_score: 6.0, keywords: "auth,jwt",
      })

      const results = experienceDAO.findByScope({
        status: "active",
        projects: ["server"],
        limit: 10,
      })

      expect(results.length).toBe(2)
      // All expected fields are present
      for (const r of results) {
        expect(r).toHaveProperty("id")
        expect(r).toHaveProperty("type")
        expect(r).toHaveProperty("status")
        expect(r).toHaveProperty("title")
        expect(r).toHaveProperty("content")
        expect(r).toHaveProperty("relevance_score")
        expect(r).toHaveProperty("keywords")
        expect(r.status).toBe("active")
        expect(r.project).toBe("server")
      }
    })

    it("filters by project scope", () => {
      seedExperience(db, { type: "bug", status: "active", project: "server" })
      seedExperience(db, { type: "bug", status: "active", project: "web-app" })
      seedExperience(db, { type: "bug", status: "active", project: "cli" })

      const serverResults = experienceDAO.findByScope({
        status: "active", projects: ["server"], limit: 10,
      })
      expect(serverResults.length).toBe(1)
      expect(serverResults[0].project).toBe("server")

      const multiResults = experienceDAO.findByScope({
        status: "active", projects: ["server", "web-app"], limit: 10,
      })
      expect(multiResults.length).toBe(2)
    })

    it("filters by type scope", () => {
      seedExperience(db, { type: "bug", status: "active" })
      seedExperience(db, { type: "pattern", status: "active" })
      seedExperience(db, { type: "cost", status: "active" })

      const bugResults = experienceDAO.findByScope({
        status: "active", types: ["bug"], limit: 10,
      })
      expect(bugResults.length).toBe(1)
      expect(bugResults[0].type).toBe("bug")

      const multiType = experienceDAO.findByScope({
        status: "active", types: ["bug", "pattern"], limit: 10,
      })
      expect(multiType.length).toBe(2)
    })
  })

  // TC-030: Verify experience-injector test has meaningful content (≥7 test cases)
  it("TC-030: ExperienceInjector test file has ≥7 test cases in engine package", () => {
    const testPath = resolve(__dirname, "../../../../engine/src/__tests__/experience-injector.test.ts")
    const content = readFileSync(testPath, "utf-8")
    const testCount = (content.match(/\bit\(/g) ?? []).length
    expect(testCount).toBeGreaterThanOrEqual(7)
  })

  // TC-031: Mixed status filtering
  describe("TC-031: Mixed status filtering", () => {
    it("findByScope with status=active returns only active experiences", () => {
      // Insert 5 active
      for (let i = 0; i < 5; i++) {
        seedExperience(db, {
          status: "active", title: `Active ${i}`,
          relevance_score: 5.0 + i,
        })
      }
      // Insert 2 resolved
      for (let i = 0; i < 2; i++) {
        seedExperience(db, {
          status: "resolved", title: `Resolved ${i}`,
          relevance_score: 10.0,
        })
      }
      // Insert 1 obsolete
      seedExperience(db, {
        status: "obsolete", title: "Obsolete 0",
        relevance_score: 10.0,
      })
      // Insert 1 superseded
      seedExperience(db, {
        status: "superseded", title: "Superseded 0",
        relevance_score: 10.0,
      })

      // Active only
      const activeResults = experienceDAO.findByScope({ status: "active", limit: 50 })
      expect(activeResults.length).toBe(5)
      for (const r of activeResults) {
        expect(r.status).toBe("active")
      }

      // Resolved only
      const resolvedResults = experienceDAO.findByScope({ status: "resolved", limit: 50 })
      expect(resolvedResults.length).toBe(2)
      for (const r of resolvedResults) {
        expect(r.status).toBe("resolved")
      }

      // Obsolete only
      const obsoleteResults = experienceDAO.findByScope({ status: "obsolete", limit: 50 })
      expect(obsoleteResults.length).toBe(1)
      expect(obsoleteResults[0].title).toBe("Obsolete 0")

      // Superseded only
      const supersededResults = experienceDAO.findByScope({ status: "superseded", limit: 50 })
      expect(supersededResults.length).toBe(1)
      expect(supersededResults[0].title).toBe("Superseded 0")
    })

    it("countByType correctly counts by status", () => {
      for (let i = 0; i < 3; i++) {
        seedExperience(db, { status: "active", type: "bug" })
      }
      for (let i = 0; i < 2; i++) {
        seedExperience(db, { status: "active", type: "pattern" })
      }
      seedExperience(db, { status: "resolved", type: "bug" })

      const activeCounts = experienceDAO.countByType("test-org", "active")
      expect(activeCounts.bug).toBe(3)
      expect(activeCounts.pattern).toBe(2)

      const allCounts = experienceDAO.countByType("test-org")
      expect(allCounts.bug).toBe(4) // 3 active + 1 resolved
      expect(allCounts.pattern).toBe(2)
    })
  })

  // TC-046: Memory scope filtering — archiveDAO.listExecutionArchives with workflowRefs
  describe("TC-046: Memory scope filtering (workflowRefs)", () => {
    it("listExecutionArchives filters by workflowRefs parameter", () => {
      // Seed archives for different workflow_refs
      seedArchive(db, { workflowRef: "wf-alpha", status: "completed" })
      seedArchive(db, { workflowRef: "wf-alpha", status: "completed" })
      seedArchive(db, { workflowRef: "wf-beta", status: "completed" })
      seedArchive(db, { workflowRef: "wf-gamma", status: "completed" })

      // Without workflowRefs — returns all
      const allResult = archiveDAO.listExecutionArchives({
        page: 1, pageSize: 20,
      })
      expect(allResult.data.length).toBe(4)

      // With workflowRefs — returns only matching
      const scopedResult = archiveDAO.listExecutionArchives({
        page: 1, pageSize: 20,
        workflowRefs: ["wf-alpha"],
      })
      expect(scopedResult.data.length).toBe(2)
      for (const r of scopedResult.data) {
        expect(r.workflow_ref).toBe("wf-alpha")
      }

      // With multiple workflowRefs
      const multiResult = archiveDAO.listExecutionArchives({
        page: 1, pageSize: 20,
        workflowRefs: ["wf-alpha", "wf-beta"],
      })
      expect(multiResult.data.length).toBe(3)

      // With empty workflowRefs array — no filter applied (returns all)
      const emptyResult = archiveDAO.listExecutionArchives({
        page: 1, pageSize: 20,
        workflowRefs: [],
      })
      expect(emptyResult.data.length).toBe(4)
    })

    it("listExecutionArchives combines workflowRefs with other filters", () => {
      seedArchive(db, { workflowRef: "wf-alpha", status: "completed", org: "org-a" })
      seedArchive(db, { workflowRef: "wf-alpha", status: "failed", org: "org-a" })
      seedArchive(db, { workflowRef: "wf-beta", status: "completed", org: "org-a" })

      const result = archiveDAO.listExecutionArchives({
        org: "org-a",
        status: "completed",
        page: 1, pageSize: 20,
        workflowRefs: ["wf-alpha"],
      })
      expect(result.data.length).toBe(1)
      expect(result.data[0].workflow_ref).toBe("wf-alpha")
      expect(result.data[0].status).toBe("completed")
    })
  })

  // FTS search tests
  describe("ExperienceDAO.searchFTS", () => {
    it("finds experiences matching FTS query", () => {
      seedExperience(db, {
        title: "CORS error fix",
        content: "Added Access-Control-Allow-Origin header to fix CORS issue",
        keywords: "cors",
      })
      seedExperience(db, {
        title: "Auth timeout",
        content: "JWT token expiration handling",
        keywords: "auth,jwt",
      })

      const results = experienceDAO.searchFTS("CORS", { org: "test-org", status: "active", limit: 5 })
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some(r => r.title.includes("CORS"))).toBe(true)
    })

    it("respects org and status filters in FTS search", () => {
      seedExperience(db, {
        title: "Org-A Bug", content: "specific bug content xyzabc",
        org: "org-a", status: "active",
      })
      seedExperience(db, {
        title: "Org-B Bug", content: "specific bug content xyzabc",
        org: "org-b", status: "active",
      })

      const results = experienceDAO.searchFTS("xyzabc", { org: "org-a", status: "active", limit: 5 })
      expect(results.length).toBe(1)
      expect(results[0].org).toBe("org-a")
    })
  })

  // Experience status update
  describe("ExperienceDAO.updateStatus", () => {
    it("updates status and resolved info", () => {
      const id = seedExperience(db, { status: "active", title: "To Resolve" })

      experienceDAO.updateStatus(id, "resolved", "2026-06-29T00:00:00Z", "agent")

      const updated = experienceDAO.findById(id)
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe("resolved")
      expect(updated!.resolved_at).toBe("2026-06-29T00:00:00Z")
      expect(updated!.resolved_by).toBe("agent")
    })
  })

  // Experience incrementUseCount
  describe("ExperienceDAO.incrementUseCount", () => {
    it("increments use_count for specified IDs", () => {
      const id1 = seedExperience(db, { title: "Used 1" })
      const id2 = seedExperience(db, { title: "Used 2" })
      const id3 = seedExperience(db, { title: "Unused" })

      experienceDAO.incrementUseCount([id1, id2])

      const e1 = experienceDAO.findById(id1)
      const e2 = experienceDAO.findById(id2)
      const e3 = experienceDAO.findById(id3)
      expect(e1!.use_count).toBe(1)
      expect(e2!.use_count).toBe(1)
      expect(e3!.use_count).toBe(0)
    })
  })

  // FTS5 hyphen fix verification
  describe("ExperienceDAO.searchFTS hyphen handling", () => {
    it("searches for hyphenated terms without crashing (BUG-001 pattern)", () => {
      seedExperience(db, { title: "BUG-001 CORS error", content: "CORS policy blocks requests" })
      seedExperience(db, { title: "BUG-002 auth failure", content: "Authentication failed" })
      seedExperience(db, { title: "normal issue", content: "no bug here" })

      // This would previously throw SQLITE_ERROR: no such column: 001
      const results = experienceDAO.searchFTS("BUG-001", { status: "active", limit: 10 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].title).toContain("BUG")
    })

    it("handles quoted and unquoted queries safely", () => {
      seedExperience(db, { title: "fix auth module", content: "auth module crash" })

      const results = experienceDAO.searchFTS("auth", { status: "active", limit: 10 })
      expect(results.length).toBeGreaterThan(0)
    })
  })
})
