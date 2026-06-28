// packages/server/src/services/__tests__/lifecycle-service.test.ts
// TC-032/033/034: Tests for ExperienceLifecycleService (markResolved, decayStale, supersede)
import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ExperienceLifecycleService } from "../experience/lifecycle-service"
import type { KnowledgeFiles } from "../archive/knowledge-files"
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

function seedExperience(
  db: Database.Database,
  opts: {
    id?: string
    org?: string
    type?: string
    status?: string
    title?: string
    content?: string
    project?: string
    file_pattern?: string
    created_at?: string
    use_count?: number
    workflow_name?: string
  },
): string {
  const id = opts.id || randomUUID()
  db.prepare(
    `INSERT INTO experience_index
      (id, org, archive_id, workflow_name, type, status, title, content,
       project, file_pattern, keywords, relevance_score, use_count, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '', 1.0, ?, ?, ?)`,
  ).run(
    id,
    opts.org || "test-org",
    opts.workflow_name || "test-wf",
    opts.type || "bug",
    opts.status || "active",
    opts.title || "Test Bug",
    opts.content || "Test content",
    opts.project || "test-project",
    opts.file_pattern || null,
    opts.use_count ?? 0,
    opts.created_at || new Date().toISOString(),
    new Date().toISOString(),
  )
  return id
}

describe("ExperienceLifecycleService", () => {
  let db: Database.Database
  let dao: ExperienceDAO
  let mockKnowledgeFiles: { rebuild: ReturnType<typeof vi.fn> }
  let service: ExperienceLifecycleService

  beforeEach(() => {
    db = createTestDb()
    dao = new ExperienceDAO(db)
    mockKnowledgeFiles = { rebuild: vi.fn() }
    service = new ExperienceLifecycleService(
      dao,
      mockKnowledgeFiles as unknown as KnowledgeFiles,
    )
  })

  // ── TC-032: markResolved ────────────────────────────────────────────

  describe("markResolved", () => {
    it("TC-032: resolves bug experiences matched by BUG-NNN refs in PR body", async () => {
      const expId = seedExperience(db, {
        title: "BUG-001 connection pool timeout under heavy load",
        content: "Connection pool exhausted during peak traffic causing timeouts",
        type: "bug",
        status: "active",
        project: "server",
      })

      const count = await service.markResolved(
        "https://github.com/org/repo/pull/42",
        "Fixes BUG-001",
      )

      expect(count).toBe(1)

      const updated = dao.findById(expId)
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe("resolved")
      expect(updated!.resolved_by).toBe("https://github.com/org/repo/pull/42")
    })

    it("returns 0 when PR body contains no bug references", async () => {
      seedExperience(db, { title: "Some bug", status: "active" })

      const count = await service.markResolved(
        "https://github.com/org/repo/pull/99",
        "Just a regular PR with no bug refs",
      )

      expect(count).toBe(0)
    })

    it("rebuilds knowledge files for projects with remaining active experiences", async () => {
      // This experience will be resolved
      seedExperience(db, {
        title: "BUG-010 auth failure",
        type: "bug",
        status: "active",
        project: "proj-A",
      })
      // This active experience remains, so rebuild should be called for proj-A
      seedExperience(db, {
        title: "Pattern for proj-A",
        type: "pattern",
        status: "active",
        project: "proj-A",
      })

      const count = await service.markResolved(
        "https://github.com/org/repo/pull/10",
        "Fixes BUG-010",
      )

      expect(count).toBe(1)
      expect(mockKnowledgeFiles.rebuild).toHaveBeenCalledWith("proj-A")
    })
  })

  // ── TC-033: decayStale ──────────────────────────────────────────────

  describe("decayStale", () => {
    it("TC-033: decays only experiences with use_count=0 older than 90 days", async () => {
      const now = Date.now()
      const days120Ago = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString()
      const days60Ago = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString()

      // exp1: 120 days old, use_count=0 → should become obsolete
      const exp1 = seedExperience(db, {
        title: "Old unused bug",
        created_at: days120Ago,
        use_count: 0,
        project: "proj-decay",
      })

      // exp2: 60 days old, use_count=0 → should stay active (within 90-day threshold)
      const exp2 = seedExperience(db, {
        title: "Recent unused bug",
        created_at: days60Ago,
        use_count: 0,
        project: "proj-decay",
      })

      // exp3: 120 days old, use_count=5 → should stay active (used recently)
      const exp3 = seedExperience(db, {
        title: "Old but frequently used bug",
        created_at: days120Ago,
        use_count: 5,
        project: "proj-decay",
      })

      const decayedCount = await service.decayStale()

      expect(decayedCount).toBe(1)

      const r1 = dao.findById(exp1)
      expect(r1!.status).toBe("obsolete")

      const r2 = dao.findById(exp2)
      expect(r2!.status).toBe("active")

      const r3 = dao.findById(exp3)
      expect(r3!.status).toBe("active")

      // exp2 and exp3 remain active → rebuild should be called for their project
      expect(mockKnowledgeFiles.rebuild).toHaveBeenCalledWith("proj-decay")
    })

    it("does not rebuild knowledge files when nothing was decayed", async () => {
      // All experiences are recent — nothing to decay
      seedExperience(db, {
        title: "Fresh bug",
        created_at: new Date().toISOString(),
        use_count: 0,
      })

      const count = await service.decayStale()

      expect(count).toBe(0)
      expect(mockKnowledgeFiles.rebuild).not.toHaveBeenCalled()
    })
  })

  // ── TC-034: supersede ───────────────────────────────────────────────

  describe("supersede", () => {
    it("TC-034: supersedes old active experiences matching the same project/file_pattern/type", async () => {
      const oldId = seedExperience(db, {
        title: "Old TypeScript bug",
        project: "proj1",
        file_pattern: "*.ts",
        type: "bug",
        status: "active",
      })

      const newId = randomUUID()
      // Insert the new item so it exists in the DB (supersedeByDimension excludes it by id)
      seedExperience(db, {
        id: newId,
        title: "New TypeScript bug",
        project: "proj1",
        file_pattern: "*.ts",
        type: "bug",
        status: "active",
      })

      await service.supersede({
        id: newId,
        project: "proj1",
        file_pattern: "*.ts",
        type: "bug",
      })

      const oldExp = dao.findById(oldId)
      expect(oldExp!.status).toBe("superseded")

      // The new item itself should remain active (excluded by id)
      const newExp = dao.findById(newId)
      expect(newExp!.status).toBe("active")
    })

    it("does nothing when project is missing", async () => {
      const oldId = seedExperience(db, {
        title: "Bug without project",
        file_pattern: "*.ts",
        type: "bug",
        status: "active",
      })

      await service.supersede({
        id: randomUUID(),
        file_pattern: "*.ts",
        type: "bug",
      })

      const oldExp = dao.findById(oldId)
      expect(oldExp!.status).toBe("active")
    })

    it("does nothing when file_pattern is missing", async () => {
      const oldId = seedExperience(db, {
        title: "Bug without file pattern",
        project: "proj1",
        type: "bug",
        status: "active",
      })

      await service.supersede({
        id: randomUUID(),
        project: "proj1",
        type: "bug",
      })

      const oldExp = dao.findById(oldId)
      expect(oldExp!.status).toBe("active")
    })

    it("only supersedes within the same dimension (project + file_pattern + type)", async () => {
      // Same project, different file_pattern — should NOT be superseded
      const differentPattern = seedExperience(db, {
        title: "CSS bug in proj1",
        project: "proj1",
        file_pattern: "*.css",
        type: "bug",
        status: "active",
      })

      // Same project, different type — should NOT be superseded
      const differentType = seedExperience(db, {
        title: "Pattern in proj1 ts files",
        project: "proj1",
        file_pattern: "*.ts",
        type: "pattern",
        status: "active",
      })

      // Same dimension — SHOULD be superseded
      const sameDim = seedExperience(db, {
        title: "Old TS bug in proj1",
        project: "proj1",
        file_pattern: "*.ts",
        type: "bug",
        status: "active",
      })

      const newId = randomUUID()
      seedExperience(db, {
        id: newId,
        project: "proj1",
        file_pattern: "*.ts",
        type: "bug",
      })

      await service.supersede({
        id: newId,
        project: "proj1",
        file_pattern: "*.ts",
        type: "bug",
      })

      expect(dao.findById(differentPattern)!.status).toBe("active")
      expect(dao.findById(differentType)!.status).toBe("active")
      expect(dao.findById(sameDim)!.status).toBe("superseded")
    })
  })
})
