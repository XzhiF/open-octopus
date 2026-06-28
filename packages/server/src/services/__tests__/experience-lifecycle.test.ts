import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ArchiveService } from "../archive-service"
import { ExperienceLifecycleService } from "../experience-lifecycle"

let db: Database.Database
let dbPath: string
let experienceDAO: ExperienceDAO
let archiveDAO: ArchiveDAO
let archiveService: ArchiveService
let lifecycle: ExperienceLifecycleService

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  experienceDAO = new ExperienceDAO(db)
  archiveDAO = new ArchiveDAO(db)
  const executionDAO = new ExecutionDAO(db)
  const tokenUsageDAO = new TokenUsageDAO(db)
  archiveService = new ArchiveService(archiveDAO, executionDAO, tokenUsageDAO, experienceDAO)
  lifecycle = new ExperienceLifecycleService(experienceDAO, archiveDAO, archiveService)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  // Clean up any generated knowledge files
  const knowledgeBase = path.join(os.homedir(), ".octopus", "knowledge")
  if (fs.existsSync(knowledgeBase)) {
    // Only clean test-project entries
    const entries = fs.readdirSync(knowledgeBase)
    for (const entry of entries) {
      if (entry.startsWith("test-project-lifecycle")) {
        fs.rmSync(path.join(knowledgeBase, entry), { recursive: true, force: true })
      }
    }
  }
})

// ============================================================================
// markResolved
// ============================================================================

describe("ExperienceLifecycleService.markResolved", () => {
  it("marks experiences matching BUG-\\d+ pattern in PR body", () => {
    const id1 = experienceDAO.insert({
      type: "bug",
      title: "BUG-001 parser crash",
      content: "Parser crashes on null input. See BUG-001.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 10,
      use_count: 0,
    })
    const id2 = experienceDAO.insert({
      type: "bug",
      title: "BUG-002 memory leak",
      content: "Memory leak in cache module. BUG-002",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })
    experienceDAO.insert({
      type: "bug",
      title: "Unrelated bug",
      content: "Some other issue not referenced in PR.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 3,
      use_count: 0,
    })

    const prUrl = "https://github.com/org/repo/pull/42"
    const prBody = "This PR fixes BUG-001 and BUG-002."
    const resolved = lifecycle.markResolved(prUrl, prBody)

    expect(resolved).toBe(2)

    const entry1 = experienceDAO.findById(id1)
    expect(entry1!.status).toBe("resolved")
    expect(entry1!.resolved_by).toBe(prUrl)

    const entry2 = experienceDAO.findById(id2)
    expect(entry2!.status).toBe("resolved")
  })

  it("marks experiences matching Fixes #\\d+ pattern", () => {
    const id = experienceDAO.insert({
      type: "bug",
      title: "Fixes #123 auth issue",
      content: "Authentication fails on token refresh. Fixes #123",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const prUrl = "https://github.com/org/repo/pull/99"
    const prBody = "Fixes #123 by updating token refresh logic."
    const resolved = lifecycle.markResolved(prUrl, prBody)

    expect(resolved).toBeGreaterThanOrEqual(1)
    const entry = experienceDAO.findById(id)
    expect(entry!.status).toBe("resolved")
  })

  it("returns 0 when no matching experiences found", () => {
    experienceDAO.insert({
      type: "bug",
      title: "Unrelated issue",
      content: "Nothing matches.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const resolved = lifecycle.markResolved("https://github.com/org/repo/pull/1", "No refs here")
    expect(resolved).toBe(0)
  })

  it("handles empty PR body gracefully", () => {
    const resolved = lifecycle.markResolved("https://github.com/org/repo/pull/1")
    expect(resolved).toBe(0)
  })
})

// ============================================================================
// decayStale
// ============================================================================

describe("ExperienceLifecycleService.decayStale", () => {
  it("marks use_count=0 entries older than 90 days as obsolete", () => {
    // Insert an entry with old created_at and use_count=0
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString() // 100 days ago
    const id = experienceDAO.insert({
      type: "pattern",
      title: "Old unused pattern",
      content: "This pattern was never used.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
      created_at: oldDate,
    })

    // Insert a recent entry (should not be decayed)
    const recentId = experienceDAO.insert({
      type: "pattern",
      title: "Recent pattern",
      content: "Recently created.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const decayed = lifecycle.decayStale()
    expect(decayed).toBeGreaterThanOrEqual(1)

    const oldEntry = experienceDAO.findById(id)
    expect(oldEntry!.status).toBe("obsolete")

    const recentEntry = experienceDAO.findById(recentId)
    expect(recentEntry!.status).toBe("active")
  })

  it("does not decay entries with use_count > 0", () => {
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString()
    const id = experienceDAO.insert({
      type: "pattern",
      title: "Used old pattern",
      content: "This pattern was used at least once.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
      created_at: oldDate,
    })

    // Increment use count
    experienceDAO.incrementUseCount([id])

    const decayed = lifecycle.decayStale()
    // The entry with use_count > 0 should not be in the stale list
    const entry = experienceDAO.findById(id)
    expect(entry!.status).toBe("active")
    expect(entry!.use_count).toBe(1)
  })

  it("returns 0 when no stale entries exist", () => {
    experienceDAO.insert({
      type: "pattern",
      title: "Fresh pattern",
      content: "Just created.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const decayed = lifecycle.decayStale()
    expect(decayed).toBe(0)
  })
})

// ============================================================================
// supersede
// ============================================================================

describe("ExperienceLifecycleService.supersede", () => {
  it("marks same-dimension active entries as superseded", () => {
    // Insert two entries with same dimensions (project + file_pattern + type)
    const oldId = experienceDAO.insert({
      type: "bug",
      title: "Old bug report",
      content: "Original bug description.",
      project: "test-project-lifecycle",
      file_pattern: "src/parser.ts",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const newId = experienceDAO.insert({
      type: "bug",
      title: "Updated bug report",
      content: "Updated bug description with fix.",
      project: "test-project-lifecycle",
      file_pattern: "src/parser.ts",
      status: "active",
      relevance_score: 8,
      use_count: 0,
    })

    lifecycle.supersede({
      id: newId,
      project: "test-project-lifecycle",
      file_pattern: "src/parser.ts",
      type: "bug",
    })

    const oldEntry = experienceDAO.findById(oldId)
    expect(oldEntry!.status).toBe("superseded")
    expect(oldEntry!.superseded_by).toBe(newId)

    const newEntry = experienceDAO.findById(newId)
    expect(newEntry!.status).toBe("active") // not superseded
  })

  it("does not supersede entries with different dimensions", () => {
    const otherId = experienceDAO.insert({
      type: "bug",
      title: "Different file bug",
      content: "Bug in different file.",
      project: "test-project-lifecycle",
      file_pattern: "src/other.ts",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const newId = experienceDAO.insert({
      type: "bug",
      title: "Parser bug",
      content: "Bug in parser.",
      project: "test-project-lifecycle",
      file_pattern: "src/parser.ts",
      status: "active",
      relevance_score: 8,
      use_count: 0,
    })

    lifecycle.supersede({
      id: newId,
      project: "test-project-lifecycle",
      file_pattern: "src/parser.ts",
      type: "bug",
    })

    const otherEntry = experienceDAO.findById(otherId)
    expect(otherEntry!.status).toBe("active") // different file_pattern, not superseded
  })

  it("handles null file_pattern correctly", () => {
    const oldId = experienceDAO.insert({
      type: "cost",
      title: "Old cost tip",
      content: "Original cost optimization tip.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    const newId = experienceDAO.insert({
      type: "cost",
      title: "New cost tip",
      content: "Updated cost optimization tip.",
      project: "test-project-lifecycle",
      status: "active",
      relevance_score: 8,
      use_count: 0,
    })

    lifecycle.supersede({
      id: newId,
      project: "test-project-lifecycle",
      file_pattern: null,
      type: "cost",
    })

    const oldEntry = experienceDAO.findById(oldId)
    expect(oldEntry!.status).toBe("superseded")
    expect(oldEntry!.superseded_by).toBe(newId)
  })
})
