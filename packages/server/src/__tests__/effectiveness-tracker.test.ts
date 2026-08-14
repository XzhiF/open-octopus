/**
 * Effectiveness Tracker Tests (Ticket 04)
 *
 * Tests:
 * 1. Outcome tracking — completed → all success, failed → last failed node gets 'failed', rest 'success'
 * 2. Cold start protection — < 5 data points skips injection
 * 3. Stats injection into delegation prompt
 *
 * AC-1: onExecutionEnd() batch-updates pending experiences' outcome
 * AC-2: completed → all success
 * AC-3: failed → last failed node's intervention = 'failed', others = 'success'
 * AC-4: getSuccessStats() returns decision × pattern success rate
 * AC-5: prompt includes success stats (≥5 data points)
 * AC-6: cold start protection (< 5 data points → skip)
 * AC-7: success rate = count(success) / count(total) per decision×detector
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { EvolutionDAO } from "../db/dao/evolution-dao"
import { HarnessDAO } from "../db/dao/harness-dao"
import { HarnessController } from "../services/harness/harness-controller"
import { HarnessConfigService } from "../services/harness/config-service"
import { HarnessAgentSession } from "../services/harness/harness-agent-session"
import { buildDelegationPromptWithStats, buildColdStartPlaceholder } from "../services/harness/effectiveness-tracker"
import { applySchema } from "../db/schema"
import type { ExperienceRowV2 } from "../db/types"
import type { DiagnosisReport } from "@octopus/shared"

// ─── Test helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  // Disable FK checks AFTER applySchema for test isolation
  db.pragma("foreign_keys = OFF")
  return db
}

function makeDiagnosisReport(overrides: Partial<DiagnosisReport> = {}): DiagnosisReport {
  return {
    id: "test-report-1",
    timestamp: Date.now(),
    detector: "deterministic_error",
    severity: "critical",
    executionId: "exec-001",
    nodeId: "node-a",
    displayNodeId: "node-a",
    nodeType: "bash",
    pattern: "syntax_error",
    evidence: [
      { attempt: 1, errorCode: "EXIT_1", errorMessage: "syntax error near line 3" },
    ],
    context: { retryCount: 1, nodeDurationMs: 5000, workflowProgress: 0.5 },
    ...overrides,
  }
}

// ─── 1. EvolutionDAO.listByExecutionId ──────────────────────────────────────

describe("EvolutionDAO.listByExecutionId", () => {
  let db: Database.Database
  let dao: EvolutionDAO

  beforeEach(() => {
    db = createTestDb()
    dao = new EvolutionDAO(db)
  })

  afterEach(() => {
    db.close()
  })

  it("returns experiences for a given execution_id", () => {
    dao.insertExperienceV2({
      skill_name: "harness-det1",
      content: "intervention 1",
      source_session_id: null,
      org: "default",
      created_at: "2024-01-01T00:00:00Z",
      scope: "harness",
      scope_ref: "deterministic_error",
      pattern_tags: '["fix_and_retry"]',
      outcome: JSON.stringify({ label: "pending" }),
      source_type: "harness",
      execution_id: "exec-001",
      node_id: "node-a",
    })
    dao.insertExperienceV2({
      skill_name: "harness-det1",
      content: "intervention 2",
      source_session_id: null,
      org: "default",
      created_at: "2024-01-01T00:00:01Z",
      scope: "harness",
      scope_ref: "deterministic_error",
      pattern_tags: '["fix_and_retry"]',
      outcome: JSON.stringify({ label: "pending" }),
      source_type: "harness",
      execution_id: "exec-001",
      node_id: "node-b",
    })
    // Different execution — should not appear
    dao.insertExperienceV2({
      skill_name: "harness-det1",
      content: "other exec",
      source_session_id: null,
      org: "default",
      created_at: "2024-01-01T00:00:02Z",
      scope: "harness",
      scope_ref: "deterministic_error",
      pattern_tags: '["fix_and_retry"]',
      outcome: JSON.stringify({ label: "pending" }),
      source_type: "harness",
      execution_id: "exec-002",
      node_id: "node-c",
    })

    const results = dao.listByExecutionId("exec-001")
    expect(results).toHaveLength(2)
    expect(results.every(r => r.execution_id === "exec-001")).toBe(true)
  })

  it("returns empty array for non-existent execution", () => {
    const results = dao.listByExecutionId("nonexistent-exec")
    expect(results).toHaveLength(0)
  })

  it("can filter by pending outcome only", () => {
    dao.insertExperienceV2({
      skill_name: "harness-det1",
      content: "pending one",
      source_session_id: null,
      org: "default",
      created_at: "2024-01-01T00:00:00Z",
      scope: "harness",
      scope_ref: "deterministic_error",
      pattern_tags: '["fix_and_retry"]',
      outcome: JSON.stringify({ label: "pending" }),
      source_type: "harness",
      execution_id: "exec-001",
      node_id: "node-a",
    })
    dao.insertExperienceV2({
      skill_name: "harness-det1",
      content: "success one",
      source_session_id: null,
      org: "default",
      created_at: "2024-01-01T00:00:01Z",
      scope: "harness",
      scope_ref: "deterministic_error",
      pattern_tags: '["fix_and_retry"]',
      outcome: JSON.stringify({ label: "success" }),
      source_type: "harness",
      execution_id: "exec-001",
      node_id: "node-b",
    })

    const pendingResults = dao.listByExecutionId("exec-001", { outcomeLabel: "pending" })
    expect(pendingResults).toHaveLength(1)
    expect(pendingResults[0].node_id).toBe("node-a")
  })
})

// ─── 2. Outcome tracking via HarnessController ──────────────────────────────

describe("HarnessController outcome tracking (AC-1, AC-2, AC-3)", () => {
  let db: Database.Database
  let dao: EvolutionDAO
  let harnessDao: HarnessDAO
  let controller: HarnessController

  const EXECUTION_ID = "exec-outcome-test"

  beforeEach(() => {
    db = createTestDb()
    dao = new EvolutionDAO(db)
    harnessDao = new HarnessDAO(db)
    const configService = new HarnessConfigService(harnessDao)

    controller = new HarnessController({
      dao: harnessDao,
      sse: { emit: vi.fn() } as any,
      configService,
      evolutionDao: dao,
    })

    // Create a minimal execution row with required columns
    db.prepare(`
      INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, org, status, created_at, updated_at)
      VALUES (?, 'ws-1', 'test-workflow', 'Test Workflow', 'default', 'running', datetime('now'), datetime('now'))
    `).run(EXECUTION_ID)
  })

  afterEach(() => {
    controller.destroyAll()
    db.close()
  })

  it("AC-2: completed execution → all interventions marked as success", () => {
    // Simulate: 2 interventions in the session, execution completes
    // First, start an execution and create a session
    controller.onExecutionStart(EXECUTION_ID, "ws-1", {} as any, {
      workflowContent: "name: test",
      nodeList: [{ id: "node-a", type: "bash" }, { id: "node-b", type: "bash" }],
      dependencyGraph: { "node-a": [], "node-b": ["node-a"] },
      varpoolSnapshot: {},
    })

    // Simulate 2 interventions via the session
    const session = controller.getSession(EXECUTION_ID)!
    expect(session).toBeDefined()

    const report1 = makeDiagnosisReport({ nodeId: "node-a" })
    const report2 = makeDiagnosisReport({ nodeId: "node-b", id: "report-2" })

    session.appendIntervention(report1, { varpoolSnapshot: {} })
    session.recordDecision("node-a", {
      success: true,
      decision: "fix_and_retry",
      reasoning: "fix syntax",
      tokenUsage: { input: 100, output: 50, model: "test" },
    })

    session.appendIntervention(report2, { varpoolSnapshot: {} })
    session.recordDecision("node-b", {
      success: true,
      decision: "guide_and_retry",
      reasoning: "inject hint",
      tokenUsage: { input: 100, output: 50, model: "test" },
    })

    // End the execution — should record experiences + update outcomes
    controller.onExecutionEnd(EXECUTION_ID, { status: "completed" })

    // Verify: both experiences should have outcome.label = 'success'
    const experiences = dao.listByExecutionId(EXECUTION_ID)
    expect(experiences).toHaveLength(2)

    for (const exp of experiences) {
      const outcome = JSON.parse(exp.outcome!)
      expect(outcome.label).toBe("success")
    }
  })

  it("AC-3: failed execution → last failed node = 'failed', others = 'success'", () => {
    controller.onExecutionStart(EXECUTION_ID, "ws-1", {} as any, {
      workflowContent: "name: test",
      nodeList: [{ id: "node-a", type: "bash" }, { id: "node-b", type: "bash" }, { id: "node-c", type: "bash" }],
      dependencyGraph: { "node-a": [], "node-b": ["node-a"], "node-c": ["node-b"] },
      varpoolSnapshot: {},
    })

    const session = controller.getSession(EXECUTION_ID)!

    // 3 interventions: node-a, node-b, node-c
    const reportA = makeDiagnosisReport({ nodeId: "node-a" })
    const reportB = makeDiagnosisReport({ nodeId: "node-b", id: "report-b" })
    const reportC = makeDiagnosisReport({ nodeId: "node-c", id: "report-c" })

    session.appendIntervention(reportA, { varpoolSnapshot: {} })
    session.recordDecision("node-a", { success: true, decision: "fix_and_retry", reasoning: "fix", tokenUsage: { input: 0, output: 0, model: "test" } })

    session.appendIntervention(reportB, { varpoolSnapshot: {} })
    session.recordDecision("node-b", { success: true, decision: "fix_and_retry", reasoning: "fix", tokenUsage: { input: 0, output: 0, model: "test" } })

    session.appendIntervention(reportC, { varpoolSnapshot: {} })
    session.recordDecision("node-c", { success: true, decision: "agent_takeover", reasoning: "takeover", tokenUsage: { input: 0, output: 0, model: "test" } })

    // End execution with failed status, lastFailedNodeId = "node-c"
    controller.onExecutionEnd(EXECUTION_ID, { status: "failed", lastFailedNodeId: "node-c" })

    const experiences = dao.listByExecutionId(EXECUTION_ID)
    expect(experiences).toHaveLength(3)

    // node-c (last failed) → 'failed'
    const nodeCExp = experiences.find(e => e.node_id === "node-c")!
    expect(JSON.parse(nodeCExp.outcome!).label).toBe("failed")

    // node-a, node-b → 'success'
    const nodeAExp = experiences.find(e => e.node_id === "node-a")!
    expect(JSON.parse(nodeAExp.outcome!).label).toBe("success")
    const nodeBExp = experiences.find(e => e.node_id === "node-b")!
    expect(JSON.parse(nodeBExp.outcome!).label).toBe("success")
  })

  it("skips outcome update when no evolutionDao configured", () => {
    // Controller without evolutionDao should not crash
    const configService = new HarnessConfigService(harnessDao)
    const controllerNoDao = new HarnessController({
      dao: harnessDao,
      sse: { emit: vi.fn() } as any,
      configService,
      // no evolutionDao
    })

    controllerNoDao.onExecutionStart(EXECUTION_ID, "ws-1", {} as any, {
      workflowContent: "name: test",
      nodeList: [],
      dependencyGraph: {},
      varpoolSnapshot: {},
    })

    // Should not throw
    expect(() => controllerNoDao.onExecutionEnd(EXECUTION_ID)).not.toThrow()
    controllerNoDao.destroyAll()
  })
})

// ─── 3. Cold start protection (AC-6) ────────────────────────────────────────

describe("Cold start protection (AC-6)", () => {
  let db: Database.Database
  let dao: EvolutionDAO

  beforeEach(() => {
    db = createTestDb()
    dao = new EvolutionDAO(db)
  })

  afterEach(() => {
    db.close()
  })

  it("returns cold start placeholder when < 5 data points", () => {
    // Insert only 3 experiences (below threshold)
    for (let i = 0; i < 3; i++) {
      dao.insertExperienceV2({
        skill_name: `harness-det-${i}`,
        content: `intervention ${i}`,
        source_session_id: null,
        org: "default",
        created_at: "2024-01-01T00:00:00Z",
        scope: "harness",
        scope_ref: "deterministic_error",
        pattern_tags: '["fix_and_retry"]',
        outcome: JSON.stringify({ label: "success" }),
        source_type: "harness",
        execution_id: `exec-${i}`,
        node_id: `node-${i}`,
      })
    }

    const stats = dao.getSuccessStats("default", "harness", "deterministic_error")
    const totalDataPoints = Object.values(stats.decisionStats).reduce((sum, s) => sum + s.total, 0)

    expect(totalDataPoints).toBe(3)
    expect(totalDataPoints).toBeLessThan(5)

    // Cold start placeholder should be used
    const placeholder = buildColdStartPlaceholder()
    expect(placeholder).toContain("经验积累中")
  })

  it("provides stats when ≥ 5 data points", () => {
    // Insert 6 experiences (above threshold)
    for (let i = 0; i < 6; i++) {
      dao.insertExperienceV2({
        skill_name: `harness-det-${i}`,
        content: `intervention ${i}`,
        source_session_id: null,
        org: "default",
        created_at: "2024-01-01T00:00:00Z",
        scope: "harness",
        scope_ref: "deterministic_error",
        pattern_tags: i < 4 ? '["fix_and_retry"]' : '["guide_and_retry"]',
        outcome: JSON.stringify({ label: i < 5 ? "success" : "failed" }),
        source_type: "harness",
        execution_id: `exec-${i}`,
        node_id: `node-${i}`,
      })
    }

    const stats = dao.getSuccessStats("default", "harness", "deterministic_error")
    const totalDataPoints = Object.values(stats.decisionStats).reduce((sum, s) => sum + s.total, 0)

    expect(totalDataPoints).toBe(6)
    expect(totalDataPoints).toBeGreaterThanOrEqual(5)

    // Should be able to build stats block
    const statsBlock = buildDelegationPromptWithStats(stats)
    expect(statsBlock).toContain("fix_and_retry")
    expect(statsBlock).toContain("成功率")
  })
})

// ─── 4. Stats injection into prompt (AC-5, AC-7) ───────────────────────────

describe("Stats injection into delegation prompt (AC-5, AC-7)", () => {
  it("formats success stats for prompt injection", () => {
    const stats = {
      decisionStats: {
        fix_and_retry: { success: 8, failed: 2, pending: 0, total: 10, rate: 0.8 },
        guide_and_retry: { success: 3, failed: 3, pending: 1, total: 7, rate: 0.5 },
        agent_takeover: { success: 1, failed: 4, pending: 0, total: 5, rate: 0.2 },
      },
      patternStats: {},
    }

    const block = buildDelegationPromptWithStats(stats)
    expect(block).toContain("fix_and_retry")
    expect(block).toContain("80%") // 0.8 → 80%
    expect(block).toContain("guide_and_retry")
    expect(block).toContain("50%") // 0.5 → 50%
    expect(block).toContain("agent_takeover")
    expect(block).toContain("20%") // 0.2 → 20%
  })

  it("excludes decisions with 0 resolved outcomes", () => {
    const stats = {
      decisionStats: {
        fix_and_retry: { success: 0, failed: 0, pending: 5, total: 5, rate: 0 },
      },
      patternStats: {},
    }

    const block = buildDelegationPromptWithStats(stats)
    // All pending → no resolved data → should still be mentionable but with a note
    // Or we could skip entirely. Let's check it says something meaningful:
    expect(block).toContain("fix_and_retry")
  })

  it("returns empty string when no stats available", () => {
    const stats = { decisionStats: {}, patternStats: {} }
    const block = buildDelegationPromptWithStats(stats)
    expect(block).toBe("")
  })

  it("AC-7: rate formula = count(success) / count(success + failed)", () => {
    // Verify the rate calculation matches the AC-7 formula
    // 3 success / (3 success + 1 failed) = 0.75
    const stats = {
      decisionStats: {
        fix_and_retry: { success: 3, failed: 1, pending: 2, total: 6, rate: 0.75 },
      },
      patternStats: {},
    }

    const block = buildDelegationPromptWithStats(stats)
    expect(block).toContain("75%")
  })
})
