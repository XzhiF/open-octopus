// packages/server/src/services/__tests__/suggestion-engine.test.ts
// TC-025/026/027: Suggestion engine tests for pattern analysis and cost optimization.
import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import { SuggestionEngine } from "../suggestion-engine"
import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")
let testDb: Database.Database

// Mock getDb so the SuggestionEngine's internal DAO creation uses our test database.
// The analyzeRepeatingPatterns / analyzeFailurePatterns / analyzeCostOptimization methods
// call getDb() internally, creating their own DAO instances — this mock intercepts that.
vi.mock("../../db/connection", () => ({
  getDb: () => testDb,
}))

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  return db
}

// ── Seed helpers ─────────────────────────────────────────────────────────

function seedBugExperience(
  db: Database.Database,
  opts: { title: string; content: string; project?: string },
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO experience_index
      (id, org, type, status, title, content, project, package, workflow_name,
       keywords, relevance_score, use_count, created_at, updated_at)
     VALUES (?, 'test-org', 'bug', 'active', ?, ?, ?, 'server', 'test-workflow',
       '', 1.0, 0, datetime('now'), datetime('now'))`,
  ).run(id, opts.title, opts.content, opts.project || "test-project")
  return id
}

function seedArchiveRecord(
  db: Database.Database,
  opts: {
    workflow_ref: string
    workflow_name: string
    status: string
    total_cost_usd: number
    failed_nodes?: string
    error_message?: string
  },
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO execution_archive
      (id, org, workflow_ref, workflow_name, status, started_at, completed_at,
       duration_ms, node_summary, failed_nodes, error_message,
       total_input_tokens, total_output_tokens, total_cost_usd, model_breakdown,
       vars_snapshot, lessons_learned, workspace_archive_id, workspace_id,
       chain_position, parent_execution_id, schedule_id, clone_name, created_at)
     VALUES (?, 'test-org', ?, ?, ?, datetime('now'), datetime('now'),
       60000, '[]', ?, ?, 1000, 500, ?, '{}', '{}', NULL, NULL,
       'ws-1', NULL, NULL, NULL, NULL, datetime('now'))`,
  ).run(
    id,
    opts.workflow_ref,
    opts.workflow_name,
    opts.status,
    opts.failed_nodes || null,
    opts.error_message || null,
    opts.total_cost_usd,
  )
  return id
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("SuggestionEngine", () => {
  let db: Database.Database
  let experienceDAO: ExperienceDAO
  let archiveDAO: ArchiveDAO

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb
    experienceDAO = new ExperienceDAO(db)
    archiveDAO = new ArchiveDAO(db)
  })

  // ── analyzeRepeatingPatterns (TC-025) ──────────────────────────────────

  describe("analyzeRepeatingPatterns", () => {
    it("TC-025: detects clusters of similar bugs via Jaccard similarity", () => {
      // Seed 3 bugs with high lexical overlap (CORS-related content).
      // Jaccard("cors api endpoint" vs "cors webhook endpoint") ≈ 0.8 > 0.6 threshold
      seedBugExperience(db, {
        title: "BUG: CORS error in API endpoint",
        content: "CORS policy blocks request from frontend to API endpoint causing failures in production",
        project: "web-app",
      })
      seedBugExperience(db, {
        title: "BUG: CORS error in webhook handler",
        content: "CORS policy blocks request from webhook to API endpoint causing failures in production",
        project: "web-app",
      })
      seedBugExperience(db, {
        title: "BUG: CORS error in dashboard panel",
        content: "CORS policy blocks request from dashboard to API endpoint causing failures in production",
        project: "web-app",
      })

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeRepeatingPatterns("test-org", 7)

      expect(suggestions.length).toBeGreaterThanOrEqual(1)
      expect(suggestions[0].ruleName).toBe("RepeatingBugPattern")
      expect(suggestions[0].severity).toBe("warning")
      expect(suggestions[0].detection).toMatch(/3/)
      expect(suggestions[0].detection).toContain("Jaccard")
    })

    it("returns empty when fewer than 3 bugs exist", () => {
      seedBugExperience(db, {
        title: "BUG: Lonely error",
        content: "A single isolated bug with no similar peers",
      })
      seedBugExperience(db, {
        title: "BUG: Different issue entirely",
        content: "Something completely unrelated to the first bug",
      })

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeRepeatingPatterns("test-org", 7)

      expect(suggestions).toEqual([])
    })

    it("does not cluster dissimilar bugs even if there are 3+", () => {
      seedBugExperience(db, {
        title: "BUG: Database connection timeout",
        content: "PostgreSQL connection pool exhausted after 30 seconds of waiting",
      })
      seedBugExperience(db, {
        title: "BUG: CSS layout broken on mobile",
        content: "Flexbox wrapping causes overlapping elements on small viewports",
      })
      seedBugExperience(db, {
        title: "BUG: Authentication token expired",
        content: "JWT refresh flow fails silently when the token has been revoked",
      })

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeRepeatingPatterns("test-org", 7)

      // All 3 bugs are lexically distinct — Jaccard < 0.6, no clusters formed
      expect(suggestions).toEqual([])
    })
  })

  // ── analyzeFailurePatterns (TC-026) ────────────────────────────────────

  describe("analyzeFailurePatterns", () => {
    it("TC-026: detects repeating failure patterns in high-failure workflows", () => {
      // 6 executions for the same workflow: 5 failed + 1 completed → 83% failure rate
      // All failures share the same failed_nodes + error_message pattern
      for (let i = 0; i < 5; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-flaky",
          workflow_name: "Flaky Workflow",
          status: "failed",
          total_cost_usd: 0.5,
          failed_nodes: "build",
          error_message: "Node build failed: timeout after 30s",
        })
      }
      seedArchiveRecord(db, {
        workflow_ref: "wf-flaky",
        workflow_name: "Flaky Workflow",
        status: "completed",
        total_cost_usd: 0.3,
      })

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeFailurePatterns("test-org")

      expect(suggestions.length).toBeGreaterThanOrEqual(1)

      // Should detect the repeating failure pattern (same error across 5 executions)
      const repeating = suggestions.find((s) => s.ruleName === "RepeatingFailurePattern")
      expect(repeating).toBeDefined()
      expect(repeating!.severity).toBe("critical")
      expect(repeating!.title).toContain("Flaky Workflow")
      expect(repeating!.detection).toContain("build")

      // Should also detect the overall high failure rate (> 50%)
      const highRate = suggestions.find((s) => s.ruleName === "HighFailureRate")
      expect(highRate).toBeDefined()
      expect(highRate!.severity).toBe("critical")
    })

    it("ignores workflows with low failure rate", () => {
      // 5 completed + 1 failed → 17% failure rate, below the 30% threshold
      for (let i = 0; i < 5; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-stable",
          workflow_name: "Stable Workflow",
          status: "completed",
          total_cost_usd: 0.3,
        })
      }
      seedArchiveRecord(db, {
        workflow_ref: "wf-stable",
        workflow_name: "Stable Workflow",
        status: "failed",
        total_cost_usd: 0.5,
        failed_nodes: "deploy",
        error_message: "Deploy failed: permission denied",
      })

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeFailurePatterns("test-org")

      expect(suggestions).toEqual([])
    })

    it("ignores workflows with fewer than 5 executions", () => {
      // 3 failed executions — below the execution_count >= 5 threshold
      for (let i = 0; i < 3; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-new",
          workflow_name: "New Workflow",
          status: "failed",
          total_cost_usd: 0.5,
          failed_nodes: "test",
          error_message: "Tests failed",
        })
      }

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeFailurePatterns("test-org")

      expect(suggestions).toEqual([])
    })
  })

  // ── analyzeCostOptimization (TC-027) ───────────────────────────────────

  describe("analyzeCostOptimization", () => {
    it("TC-027: detects high-cost workflows with avg cost > $1.00", () => {
      // 5 executions at $1.50 each → avg $1.50 > $1.00 threshold
      for (let i = 0; i < 5; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-expensive",
          workflow_name: "Expensive Workflow",
          status: "completed",
          total_cost_usd: 1.5,
        })
      }

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeCostOptimization("test-org")

      expect(suggestions.length).toBe(1)
      expect(suggestions[0].ruleName).toBe("HighCostWorkflow")
      expect(suggestions[0].severity).toBe("info")
      expect(suggestions[0].title).toContain("Expensive Workflow")
      expect(suggestions[0].detection).toContain("$1.50")
      // estimatedSaving: total_cost * 0.5 = 7.5 * 0.5 = $3.75
      expect(suggestions[0].impactEstimate).toContain("$3.75")
    })

    it("ignores workflows with avg cost <= $1.00", () => {
      // 5 executions at $0.50 each → avg $0.50 < $1.00 threshold
      for (let i = 0; i < 5; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-cheap",
          workflow_name: "Cheap Workflow",
          status: "completed",
          total_cost_usd: 0.5,
        })
      }

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeCostOptimization("test-org")

      expect(suggestions).toEqual([])
    })

    it("handles multiple workflows independently", () => {
      // Expensive workflow: avg $2.00
      for (let i = 0; i < 3; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-pricey",
          workflow_name: "Pricey Workflow",
          status: "completed",
          total_cost_usd: 2.0,
        })
      }
      // Cheap workflow: avg $0.20
      for (let i = 0; i < 3; i++) {
        seedArchiveRecord(db, {
          workflow_ref: "wf-budget",
          workflow_name: "Budget Workflow",
          status: "completed",
          total_cost_usd: 0.2,
        })
      }

      const engine = new SuggestionEngine()
      const suggestions = engine.analyzeCostOptimization("test-org")

      // Only the expensive workflow should be flagged
      expect(suggestions.length).toBe(1)
      expect(suggestions[0].title).toContain("Pricey Workflow")
    })
  })

  // ── generate (built-in rules) ─────────────────────────────────────────

  describe("generate", () => {
    it("returns empty suggestions when no data exists", () => {
      const tokenDao = new TokenUsageDAO(db)
      const execDao = new ExecutionDAO(db)

      const engine = new SuggestionEngine()
      const suggestions = engine.generate({
        tokenDao,
        execDao,
        workspaceId: "ws-nonexistent",
        workflowRef: "wf-test",
      })

      expect(suggestions).toEqual([])
    })

    it("runs all 5 built-in rules without throwing", () => {
      const tokenDao = new TokenUsageDAO(db)
      const execDao = new ExecutionDAO(db)

      const engine = new SuggestionEngine()

      // Should not throw even with missing workspace/execution data
      expect(() =>
        engine.generate({
          tokenDao,
          execDao,
          workspaceId: "ws-test",
          workflowRef: "wf-test",
        }),
      ).not.toThrow()
    })
  })

  // ── persistSuggestion / applySuggestion ────────────────────────────────

  describe("persistSuggestion and applySuggestion", () => {
    it("persists a suggestion and retrieves it sorted by severity", () => {
      const workspaceDAO = new WorkspaceDAO(db)
      const wsId = "ws-test-persist"
      const now = new Date().toISOString()
      workspaceDAO.insert({
        id: wsId,
        name: "Test Workspace",
        org: "test-org",
        description: null,
        path: "/tmp/test-ws",
        created_at: now,
        updated_at: now,
      })

      const engine = new SuggestionEngine()

      const id1 = engine.persistSuggestion(workspaceDAO, wsId, "wf-test", {
        ruleName: "TestRule",
        severity: "info",
        title: "Test suggestion",
        detection: "Detected something",
        diagnosis: "Diagnosed the issue",
        prescription: "Fix it this way",
      })
      expect(id1).toBeTruthy()

      const id2 = engine.persistSuggestion(workspaceDAO, wsId, "wf-test", {
        ruleName: "CriticalRule",
        severity: "critical",
        title: "Critical issue found",
        detection: "Found critical pattern",
        diagnosis: "Root cause identified",
        prescription: "Immediate fix required",
      })

      const suggestions = engine.getSuggestions(workspaceDAO, wsId)
      expect(suggestions.length).toBe(2)
      // Critical severity sorts before info (see findSuggestionsSorted ORDER BY CASE)
      expect(suggestions[0].severity).toBe("critical")
      expect(suggestions[0].rule_name).toBe("CriticalRule")
      expect(suggestions[1].severity).toBe("info")
    })

    it("applies a suggestion and updates its status", () => {
      const workspaceDAO = new WorkspaceDAO(db)
      const wsId = "ws-test-apply"
      const now = new Date().toISOString()
      workspaceDAO.insert({
        id: wsId,
        name: "Apply Test",
        org: "test-org",
        description: null,
        path: "/tmp/test-apply",
        created_at: now,
        updated_at: now,
      })

      const engine = new SuggestionEngine()
      const id = engine.persistSuggestion(workspaceDAO, wsId, "wf-test", {
        ruleName: "ApplyTest",
        severity: "warning",
        title: "Apply me",
        detection: "Detected",
        diagnosis: "Diagnosed",
        prescription: "Do this",
      })

      const applied = engine.applySuggestion(workspaceDAO, id, { model: "haiku" })
      expect(applied).toBe(true)

      // Verify the suggestion is now marked as applied
      const row = workspaceDAO.findSuggestionById(id)
      expect(row).not.toBeNull()
      expect(row!.status).toBe("applied")
      expect(row!.applied_changes).toBe(JSON.stringify({ model: "haiku" }))
    })

    it("returns false when applying a non-existent suggestion", () => {
      const workspaceDAO = new WorkspaceDAO(db)
      const engine = new SuggestionEngine()

      const applied = engine.applySuggestion(workspaceDAO, "non-existent-id", { foo: "bar" })
      expect(applied).toBe(false)
    })
  })
})
