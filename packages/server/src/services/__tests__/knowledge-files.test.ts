// packages/server/src/services/__tests__/knowledge-files.test.ts
// Tests for KnowledgeFiles.rebuild(): generates per-type markdown files
// from active experiences, capped at 50 entries per type.
import { describe, it, expect, beforeEach, afterAll } from "vitest"
import Database from "better-sqlite3"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { KnowledgeFiles } from "../archive/knowledge-files"
import { randomUUID } from "crypto"
import { readFileSync, existsSync, rmSync } from "fs"
import { join } from "path"
import { homedir } from "os"
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
  relevance_score?: number; project?: string; content?: string;
  keywords?: string
}) {
  const id = opts.id || randomUUID()
  db.prepare(
    `INSERT INTO experience_index (id, org, type, status, title, content, project, keywords, relevance_score, use_count, workflow_name, created_at, updated_at)
     VALUES (?, 'test-org', ?, ?, ?, ?, ?, ?, ?, 0, 'wf', datetime('now'), datetime('now'))`
  ).run(
    id,
    opts.type || "bug",
    opts.status || "active",
    opts.title || `Bug ${id}`,
    opts.content || "test content",
    opts.project || "test-project",
    opts.keywords || "",
    opts.relevance_score ?? 1.0
  )
  return id
}

const TEST_PROJECT = "test-project"
const KNOWLEDGE_DIR = join(homedir(), ".octopus", "knowledge", TEST_PROJECT)

afterAll(() => {
  if (existsSync(KNOWLEDGE_DIR)) {
    rmSync(KNOWLEDGE_DIR, { recursive: true, force: true })
  }
})

describe("KnowledgeFiles", () => {
  let db: Database.Database
  let experienceDAO: ExperienceDAO
  let knowledgeFiles: KnowledgeFiles

  beforeEach(() => {
    db = createTestDb()
    experienceDAO = new ExperienceDAO(db)
    knowledgeFiles = new KnowledgeFiles(experienceDAO)

    // Clean up knowledge dir before each test
    if (existsSync(KNOWLEDGE_DIR)) {
      rmSync(KNOWLEDGE_DIR, { recursive: true, force: true })
    }
  })

  // TC-013: Only active experiences are included in rebuild
  it("TC-013: rebuild includes only active experiences, excludes resolved", () => {
    // Insert 5 active experiences
    for (let i = 0; i < 5; i++) {
      seedExperience(db, {
        type: "bug",
        status: "active",
        title: `Active Bug ${i}`,
        relevance_score: 1.0 + i,
      })
    }
    // Insert 2 resolved experiences
    for (let i = 0; i < 2; i++) {
      seedExperience(db, {
        type: "bug",
        status: "resolved",
        title: `Resolved Bug ${i}`,
        relevance_score: 10.0, // High score but should be excluded
      })
    }

    knowledgeFiles.rebuild(TEST_PROJECT)

    const bugFile = join(KNOWLEDGE_DIR, "bugs.md")
    expect(existsSync(bugFile)).toBe(true)

    const content = readFileSync(bugFile, "utf-8")
    // All 5 active bugs should be present
    for (let i = 0; i < 5; i++) {
      expect(content).toContain(`Active Bug ${i}`)
    }
    // Resolved bugs should NOT appear
    for (let i = 0; i < 2; i++) {
      expect(content).not.toContain(`Resolved Bug ${i}`)
    }
  })

  // TC-014: At most 50 entries per type (sorted by relevance_score DESC)
  it("TC-014: rebuild caps entries at 50 per type, keeping highest relevance", () => {
    // Insert 60 active experiences with varying relevance scores
    // Use zero-padded names to avoid substring matching issues
    for (let i = 0; i < 60; i++) {
      seedExperience(db, {
        type: "bug",
        status: "active",
        title: `BugNum-${String(i).padStart(3, "0")}`,
        relevance_score: i, // 0..59
      })
    }

    knowledgeFiles.rebuild(TEST_PROJECT)

    const bugFile = join(KNOWLEDGE_DIR, "bugs.md")
    expect(existsSync(bugFile)).toBe(true)

    const content = readFileSync(bugFile, "utf-8")

    // The top 50 by relevance_score are scores 10..59 (BugNum-010 to BugNum-059)
    // The bottom 10 (scores 0-9, BugNum-000 to BugNum-009) should be excluded
    for (let i = 10; i < 60; i++) {
      expect(content).toContain(`BugNum-${String(i).padStart(3, "0")}`)
    }
    for (let i = 0; i < 10; i++) {
      expect(content).not.toContain(`BugNum-${String(i).padStart(3, "0")}`)
    }
  })

  // Additional: rebuild creates separate files per type
  it("rebuild creates separate files for each type with content", () => {
    seedExperience(db, { type: "bug", status: "active", title: "My Bug" })
    seedExperience(db, { type: "pattern", status: "active", title: "My Pattern" })
    seedExperience(db, { type: "failure", status: "active", title: "My Failure" })
    // cost type also supported
    seedExperience(db, { type: "cost", status: "active", title: "My Cost" })

    knowledgeFiles.rebuild(TEST_PROJECT)

    expect(existsSync(join(KNOWLEDGE_DIR, "bugs.md"))).toBe(true)
    expect(existsSync(join(KNOWLEDGE_DIR, "patterns.md"))).toBe(true)
    expect(existsSync(join(KNOWLEDGE_DIR, "failures.md"))).toBe(true)
    expect(existsSync(join(KNOWLEDGE_DIR, "costs.md"))).toBe(true)

    const bugContent = readFileSync(join(KNOWLEDGE_DIR, "bugs.md"), "utf-8")
    expect(bugContent).toContain("My Bug")

    const patternContent = readFileSync(join(KNOWLEDGE_DIR, "patterns.md"), "utf-8")
    expect(patternContent).toContain("My Pattern")
  })

  // Additional: rebuild with no experiences for a type does not create file
  it("rebuild does not create file for types with no active experiences", () => {
    seedExperience(db, { type: "bug", status: "active", title: "Only Bug" })

    knowledgeFiles.rebuild(TEST_PROJECT)

    expect(existsSync(join(KNOWLEDGE_DIR, "bugs.md"))).toBe(true)
    // Other types have no entries, so their files should not exist
    expect(existsSync(join(KNOWLEDGE_DIR, "patterns.md"))).toBe(false)
    expect(existsSync(join(KNOWLEDGE_DIR, "costs.md"))).toBe(false)
    expect(existsSync(join(KNOWLEDGE_DIR, "failures.md"))).toBe(false)
  })

  // Additional: rebuild filters by project
  it("rebuild only includes experiences for the specified project", () => {
    seedExperience(db, { type: "bug", status: "active", title: "Correct Project", project: "test-project" })
    seedExperience(db, { type: "bug", status: "active", title: "Other Project", project: "other-project" })

    knowledgeFiles.rebuild(TEST_PROJECT)

    const bugFile = join(KNOWLEDGE_DIR, "bugs.md")
    expect(existsSync(bugFile)).toBe(true)

    const content = readFileSync(bugFile, "utf-8")
    expect(content).toContain("Correct Project")
    expect(content).not.toContain("Other Project")
  })

  // Additional: markdown format includes keywords
  it("rebuild includes keywords in generated markdown", () => {
    seedExperience(db, {
      type: "bug",
      status: "active",
      title: "CORS Issue",
      content: "Fix CORS headers",
      keywords: "cors,api,headers",
    })

    knowledgeFiles.rebuild(TEST_PROJECT)

    const content = readFileSync(join(KNOWLEDGE_DIR, "bugs.md"), "utf-8")
    expect(content).toContain("CORS Issue")
    expect(content).toContain("cors,api,headers")
    expect(content).toContain("**Keywords:**")
  })

  // Additional: items sorted by relevance_score descending within file
  it("rebuild sorts items by relevance_score descending", () => {
    seedExperience(db, { type: "bug", status: "active", title: "Low Score", relevance_score: 1.0 })
    seedExperience(db, { type: "bug", status: "active", title: "High Score", relevance_score: 10.0 })
    seedExperience(db, { type: "bug", status: "active", title: "Mid Score", relevance_score: 5.0 })

    knowledgeFiles.rebuild(TEST_PROJECT)

    const content = readFileSync(join(KNOWLEDGE_DIR, "bugs.md"), "utf-8")
    const highIdx = content.indexOf("High Score")
    const midIdx = content.indexOf("Mid Score")
    const lowIdx = content.indexOf("Low Score")

    expect(highIdx).toBeGreaterThan(-1)
    expect(midIdx).toBeGreaterThan(-1)
    expect(lowIdx).toBeGreaterThan(-1)
    // High score appears before mid, mid before low
    expect(highIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(lowIdx)
  })
})
