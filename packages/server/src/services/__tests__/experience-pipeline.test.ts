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

let db: Database.Database
let dbPath: string
let archiveDAO: ArchiveDAO
let executionDAO: ExecutionDAO
let tokenUsageDAO: TokenUsageDAO
let experienceDAO: ExperienceDAO
let archiveService: ArchiveService

const WORKSPACE_ID = "ws-pipeline-001"
const ORG = "xzf"

function seedWorkspace() {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(WORKSPACE_ID, "test-ws", ORG, `/tmp/${WORKSPACE_ID}`, now, now)
}

function seedExecution(opts: {
  id: string
  status?: string
  duration?: number
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, org, created_at, updated_at, var_pool, duration, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, WORKSPACE_ID, "0", 0,
    "test-workflow.yaml", "Test Workflow",
    opts.status ?? "completed", ORG, now, now,
    "{}", opts.duration ?? 1000, now, now,
  )
}

function seedNodeExecution(opts: {
  id: string
  executionId: string
  nodeId: string
  status?: string
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.executionId, opts.nodeId, "agent",
    opts.status ?? "completed", now, now, 500,
  )
}

function seedTokenUsage(opts: {
  id: string
  nodeExecutionId: string
  costUsd: number
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.nodeExecutionId, "claude-sonnet-4-20250514",
    100, 50, opts.costUsd, 0, 0, now,
  )
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  archiveDAO = new ArchiveDAO(db)
  executionDAO = new ExecutionDAO(db)
  tokenUsageDAO = new TokenUsageDAO(db)
  experienceDAO = new ExperienceDAO(db)
  archiveService = new ArchiveService(archiveDAO, executionDAO, tokenUsageDAO, experienceDAO)

  seedWorkspace()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

// ============================================================================
// extractLessons — cost gate
// ============================================================================

describe("ArchiveService.extractLessons — cost gate", () => {
  it("returns null when archive not found", async () => {
    const result = await archiveService.extractLessons("nonexistent")
    expect(result).toBeNull()
  })

  it("skips LLM when cost < $1 and status is completed", async () => {
    // Create archive with low cost
    seedExecution({ id: "exec-low-cost", status: "completed" })
    seedNodeExecution({ id: "exec-low-cost-n1", executionId: "exec-low-cost", nodeId: "n1" })
    seedTokenUsage({ id: "tu-low", nodeExecutionId: "exec-low-cost-n1", costUsd: 0.50 })

    archiveService.archiveExecution("exec-low-cost")
    const archive = archiveDAO.getArchive("exec-low-cost")
    expect(archive).not.toBeNull()
    expect(archive!.total_cost_usd).toBeCloseTo(0.50, 5)

    const result = await archiveService.extractLessons("exec-low-cost")
    expect(result).toBeNull()
    // lessons_learned should remain null (no LLM call)
    const updated = archiveDAO.getArchive("exec-low-cost")
    expect(updated!.lessons_learned).toBeNull()
  })

  it("proceeds with extraction when cost >= $1 (returns null due to deferred LLM)", async () => {
    seedExecution({ id: "exec-high-cost", status: "completed" })
    seedNodeExecution({ id: "exec-high-cost-n1", executionId: "exec-high-cost", nodeId: "n1" })
    seedTokenUsage({ id: "tu-high", nodeExecutionId: "exec-high-cost-n1", costUsd: 1.50 })

    archiveService.archiveExecution("exec-high-cost")
    const archive = archiveDAO.getArchive("exec-high-cost")
    expect(archive).not.toBeNull()
    expect(archive!.total_cost_usd).toBeCloseTo(1.50, 5)

    // Should pass cost gate but return null since LLM is deferred
    const result = await archiveService.extractLessons("exec-high-cost")
    expect(result).toBeNull()
  })

  it("proceeds with extraction when status is failed (even if cost < $1)", async () => {
    seedExecution({ id: "exec-failed", status: "failed" })
    seedNodeExecution({ id: "exec-failed-n1", executionId: "exec-failed", nodeId: "n1", status: "failed" })
    seedTokenUsage({ id: "tu-fail", nodeExecutionId: "exec-failed-n1", costUsd: 0.10 })

    archiveService.archiveExecution("exec-failed")
    const archive = archiveDAO.getArchive("exec-failed")
    expect(archive).not.toBeNull()
    expect(archive!.status).toBe("failed")

    // Failed status bypasses cost gate
    const result = await archiveService.extractLessons("exec-failed")
    expect(result).toBeNull() // Still null because LLM is deferred
  })
})

// ============================================================================
// updateKnowledgeFiles
// ============================================================================

describe("ArchiveService.updateKnowledgeFiles", () => {
  const knowledgeBase = path.join(os.homedir(), ".octopus", "knowledge", "test-project-p2")

  afterEach(() => {
    // Clean up generated files
    if (fs.existsSync(knowledgeBase)) {
      fs.rmSync(knowledgeBase, { recursive: true, force: true })
    }
  })

  it("generates markdown files for active experiences", () => {
    // Insert active experiences
    experienceDAO.insert({
      type: "bug",
      title: "Null pointer in parser",
      content: "The parser crashes on null input.",
      project: "test-project-p2",
      status: "active",
      relevance_score: 10,
      use_count: 0,
    })
    experienceDAO.insert({
      type: "bug",
      title: "Memory leak in cache",
      content: "Cache entries are never evicted.",
      project: "test-project-p2",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    archiveService.updateKnowledgeFiles("test-project-p2")

    const bugFile = path.join(knowledgeBase, "bug.md")
    expect(fs.existsSync(bugFile)).toBe(true)
    const content = fs.readFileSync(bugFile, "utf-8")
    expect(content).toContain("# Bug Experiences")
    expect(content).toContain("Null pointer in parser")
    expect(content).toContain("Memory leak in cache")
    expect(content).toContain("Auto-generated from experience_index")
  })

  it("overwrites existing files (not append)", () => {
    experienceDAO.insert({
      type: "pattern",
      title: "Old pattern",
      content: "This should be replaced.",
      project: "test-project-p2",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    archiveService.updateKnowledgeFiles("test-project-p2")
    const patternFile = path.join(knowledgeBase, "pattern.md")
    const firstContent = fs.readFileSync(patternFile, "utf-8")
    expect(firstContent).toContain("Old pattern")

    // Now mark old as resolved and add new
    const entries = experienceDAO.getActiveByProject("test-project-p2", "pattern")
    for (const e of entries) {
      experienceDAO.updateStatus(e.id, "resolved")
    }
    experienceDAO.insert({
      type: "pattern",
      title: "New pattern",
      content: "This replaces the old one.",
      project: "test-project-p2",
      status: "active",
      relevance_score: 8,
      use_count: 0,
    })

    archiveService.updateKnowledgeFiles("test-project-p2")
    const secondContent = fs.readFileSync(patternFile, "utf-8")
    expect(secondContent).toContain("New pattern")
    expect(secondContent).not.toContain("Old pattern") // overwritten, not appended
  })

  it("does not include resolved entries in knowledge files", () => {
    experienceDAO.insert({
      type: "cost",
      title: "Active cost tip",
      content: "Use haiku for cheap tasks.",
      project: "test-project-p2",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })
    const resolvedId = experienceDAO.insert({
      type: "cost",
      title: "Resolved cost tip",
      content: "This was resolved.",
      project: "test-project-p2",
      status: "active",
      relevance_score: 3,
      use_count: 0,
    })

    // Mark one as resolved
    experienceDAO.updateStatus(resolvedId, "resolved")

    archiveService.updateKnowledgeFiles("test-project-p2")
    const costFile = path.join(knowledgeBase, "cost.md")
    const content = fs.readFileSync(costFile, "utf-8")
    expect(content).toContain("Active cost tip")
    expect(content).not.toContain("Resolved cost tip")
  })

  it("creates directory if it does not exist", () => {
    const newProject = "test-project-p2-newdir"
    const newDir = path.join(os.homedir(), ".octopus", "knowledge", newProject)

    // Ensure directory doesn't exist
    if (fs.existsSync(newDir)) {
      fs.rmSync(newDir, { recursive: true, force: true })
    }

    experienceDAO.insert({
      type: "failure",
      title: "Build failure",
      content: "TypeScript compilation error.",
      project: newProject,
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    archiveService.updateKnowledgeFiles(newProject)
    expect(fs.existsSync(path.join(newDir, "failure.md"))).toBe(true)

    // Cleanup
    if (fs.existsSync(newDir)) {
      fs.rmSync(newDir, { recursive: true, force: true })
    }
  })
})
