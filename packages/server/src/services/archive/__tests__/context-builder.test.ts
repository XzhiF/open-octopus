import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { WorkspaceDAO } from "../../../db/dao/workspace-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"

vi.mock("../../knowledge/file-ops", () => ({
  listAllActiveRules: vi.fn(),
}))

import { buildArchiveContext } from "../context-builder"
import { listAllActiveRules } from "../../knowledge/file-ops"

function createTestDb() {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

function seedWorkspace(db: Database.Database, id: string, name = "test-ws") {
  db.prepare(`
    INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, created_at, updated_at)
    VALUES (?, ?, 'test-org', null, 'active', '/tmp/test', 'user', null, datetime('now'), datetime('now'))
  `).run(id, name)
}

function seedExecution(
  db: Database.Database,
  id: string,
  wsId: string,
  status = "completed",
  workflowName = "test-workflow",
  duration = 1000,
  startedAt = "2024-01-01T00:00:00Z",
) {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, parent_id, duration, started_at, completed_at, created_at, updated_at)
    VALUES (?, ?, 'test-org', 'test.yaml', ?, ?, '0', ?, ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(id, wsId, workflowName, status, duration, startedAt)
}

function seedNodeExecution(
  db: Database.Database,
  id: string,
  execId: string,
  nodeId: string,
  nodeType: string,
  status = "completed",
  duration = 100,
  error: string | null = null,
) {
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, error)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
  `).run(id, execId, nodeId, nodeType, status, duration, error)
}

function seedLlmCall(
  db: Database.Database,
  id: string,
  execId: string,
  nodeExecId: string,
  model: string,
  costUsd: number,
  inputTokens = 100,
  outputTokens = 50,
) {
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, 0, 0, 1000, 500, ?, ?, ?, ?, 20, 10)
  `).run(id, nodeExecId, execId, model, inputTokens, outputTokens, costUsd)
}

describe("buildArchiveContext", () => {
  let db: Database.Database
  let workspaceDAO: WorkspaceDAO
  let executionDAO: ExecutionDAO

  beforeEach(() => {
    db = createTestDb()
    workspaceDAO = new WorkspaceDAO(db)
    executionDAO = new ExecutionDAO(db)
    vi.clearAllMocks()
    vi.mocked(listAllActiveRules).mockReturnValue([])
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
  })

  it("returns null when workspace not found", async () => {
    const result = await buildArchiveContext("nonexistent", workspaceDAO, executionDAO, db, "test-org")
    expect(result).toBeNull()
  })

  it("builds context for workspace with no executions", async () => {
    seedWorkspace(db, "ws-1", "empty-ws")

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result).not.toBeNull()
    expect(result!.workspace.id).toBe("ws-1")
    expect(result!.workspace.name).toBe("empty-ws")
    expect(result!.workspace.org).toBe("test-org")
    expect(result!.executions).toEqual([])
    expect(result!.workflows).toEqual([])
    expect(result!.errorCatalog).toEqual([])
    expect(result!.costProfile.total_cost).toBe(0)
    expect(result!.nodePatterns).toEqual([])
    expect(result!.existingKnowledge).toEqual([])
  })

  it("builds execution summary with failed nodes", async () => {
    seedWorkspace(db, "ws-1")
    seedExecution(db, "exec-1", "ws-1", "failed")
    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash", "completed")
    seedNodeExecution(db, "ne-2", "exec-1", "node-2", "agent", "failed", 100, "Error: test failure")

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.executions).toHaveLength(1)
    expect(result!.executions[0].status).toBe("failed")
    expect(result!.executions[0].failedNodes).toHaveLength(1)
    expect(result!.executions[0].failedNodes[0].node_id).toBe("node-2")
    expect(result!.executions[0].failedNodes[0].errorSnippet).toBe("Error: test failure")
  })

  it("truncates error snippets to 500 chars", async () => {
    seedWorkspace(db, "ws-1")
    seedExecution(db, "exec-1", "ws-1", "failed")
    const longError = "Error: ".padEnd(600, "x")
    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash", "failed", 100, longError)

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.executions[0].failedNodes[0].errorSnippet.length).toBe(500)
  })

  it("calculates execution cost from llm_calls", async () => {
    seedWorkspace(db, "ws-1")
    seedExecution(db, "exec-1", "ws-1")
    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash")
    seedNodeExecution(db, "ne-2", "exec-1", "node-2", "agent")
    seedLlmCall(db, "llm-1", "exec-1", "ne-1", "sonnet", 0.01)
    seedLlmCall(db, "llm-2", "exec-1", "ne-2", "sonnet", 0.02)

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.executions[0].cost).toBeCloseTo(0.03, 5)
  })

  it("samples executions when over MAX_EXECUTIONS limit", async () => {
    seedWorkspace(db, "ws-1")

    // Create 60 executions: 5 failures + 55 completed
    for (let i = 0; i < 60; i++) {
      const status = i < 5 ? "failed" : "completed"
      seedExecution(db, `exec-${i}`, "ws-1", status, "test-workflow", 1000, `2024-01-01T00:00:00Z`)
      seedNodeExecution(db, `ne-${i}`, `exec-${i}`, "node-1", "bash", status)
      if (status === "completed") {
        seedLlmCall(db, `llm-${i}`, `exec-${i}`, `ne-${i}`, "sonnet", i * 0.001)
      }
    }

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    // Should sample to MAX_EXECUTIONS (50)
    expect(result!.executions.length).toBeLessThanOrEqual(50)
    // Should include all failures
    const failures = result!.executions.filter((e) => e.status === "failed")
    expect(failures.length).toBe(5)
  })

  it("builds workflow profiles with stats", async () => {
    seedWorkspace(db, "ws-1")

    // Workflow 1: 3 executions, 2 success, 1 fail
    seedExecution(db, "exec-1", "ws-1", "completed", "workflow-1", 1000, "2024-01-01T00:00:00Z")
    seedExecution(db, "exec-2", "ws-1", "completed", "workflow-1", 2000, "2024-01-01T01:00:00Z")
    seedExecution(db, "exec-3", "ws-1", "failed", "workflow-1", 1500, "2024-01-01T02:00:00Z")

    // Workflow 2: 2 executions, both success
    seedExecution(db, "exec-4", "ws-1", "completed", "workflow-2", 800, "2024-01-01T03:00:00Z")
    seedExecution(db, "exec-5", "ws-1", "completed", "workflow-2", 1200, "2024-01-01T04:00:00Z")

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.workflows).toHaveLength(2)

    const wf1 = result!.workflows.find((w) => w.name === "workflow-1")
    expect(wf1).toBeDefined()
    expect(wf1!.count).toBe(3)
    expect(wf1!.successCount).toBe(2)
    expect(wf1!.failCount).toBe(1)
    expect(wf1!.successRate).toBeCloseTo(2 / 3, 2)
    expect(wf1!.avgDuration_s).toBeCloseTo(1.5, 1)

    const wf2 = result!.workflows.find((w) => w.name === "workflow-2")
    expect(wf2).toBeDefined()
    expect(wf2!.count).toBe(2)
    expect(wf2!.successRate).toBe(1)
  })

  it("detects increasing cost trend in workflow profiles", async () => {
    seedWorkspace(db, "ws-1")

    // 5 executions with increasing costs
    seedExecution(db, "exec-1", "ws-1", "completed", "workflow-1", 1000, "2024-01-01T00:00:00Z")
    seedExecution(db, "exec-2", "ws-1", "completed", "workflow-1", 2000, "2024-01-01T01:00:00Z")
    seedExecution(db, "exec-3", "ws-1", "completed", "workflow-1", 3000, "2024-01-01T02:00:00Z")
    seedExecution(db, "exec-4", "ws-1", "completed", "workflow-1", 4000, "2024-01-01T03:00:00Z")
    seedExecution(db, "exec-5", "ws-1", "completed", "workflow-1", 5000, "2024-01-01T04:00:00Z")

    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash")
    seedNodeExecution(db, "ne-2", "exec-2", "node-1", "bash")
    seedNodeExecution(db, "ne-3", "exec-3", "node-1", "bash")
    seedNodeExecution(db, "ne-4", "exec-4", "node-1", "bash")
    seedNodeExecution(db, "ne-5", "exec-5", "node-1", "bash")

    seedLlmCall(db, "llm-1", "exec-1", "ne-1", "sonnet", 10)
    seedLlmCall(db, "llm-2", "exec-2", "ne-2", "sonnet", 20)
    seedLlmCall(db, "llm-3", "exec-3", "ne-3", "sonnet", 30)
    seedLlmCall(db, "llm-4", "exec-4", "ne-4", "sonnet", 40)
    seedLlmCall(db, "llm-5", "exec-5", "ne-5", "sonnet", 50)

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.workflows[0].costTrendDirection).toBe("increasing")
  })

  it("builds error catalog grouped by node_id and error", async () => {
    seedWorkspace(db, "ws-1")
    seedExecution(db, "exec-1", "ws-1", "failed")
    seedExecution(db, "exec-2", "ws-1", "failed")
    seedExecution(db, "exec-3", "ws-1", "completed")

    // Same error in exec-1 and exec-2
    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash", "failed", 100, "Error: timeout")
    seedNodeExecution(db, "ne-2", "exec-2", "node-1", "bash", "failed", 100, "Error: timeout")

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.errorCatalog).toHaveLength(1)
    expect(result!.errorCatalog[0].frequency).toBe(2)
    expect(result!.errorCatalog[0].node_id).toBe("node-1")
    expect(result!.errorCatalog[0].workflowCount).toBe(2)
  })

  it("limits error catalog to MAX_ERRORS entries", async () => {
    seedWorkspace(db, "ws-1")

    // Create 25 different errors
    for (let i = 0; i < 25; i++) {
      seedExecution(db, `exec-${i}`, "ws-1", "failed")
      seedNodeExecution(db, `ne-${i}`, `exec-${i}`, `node-${i}`, "bash", "failed", 100, `Error: ${i}`)
    }

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.errorCatalog.length).toBeLessThanOrEqual(20)
  })

  it("builds cost profile with total and model breakdown", async () => {
    seedWorkspace(db, "ws-1")
    seedExecution(db, "exec-1", "ws-1")
    seedExecution(db, "exec-2", "ws-1")
    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash")
    seedNodeExecution(db, "ne-2", "exec-2", "node-1", "agent")

    seedLlmCall(db, "llm-1", "exec-1", "ne-1", "sonnet", 0.01, 100, 50)
    seedLlmCall(db, "llm-2", "exec-1", "ne-1", "opus", 0.05, 200, 100)
    seedLlmCall(db, "llm-3", "exec-2", "ne-2", "sonnet", 0.02, 150, 75)

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.costProfile.total_cost).toBeCloseTo(0.08, 5)
    expect(result!.costProfile.modelBreakdown).toHaveLength(2)

    const sonnetBreakdown = result!.costProfile.modelBreakdown.find((m) => m.model === "sonnet")
    expect(sonnetBreakdown).toBeDefined()
    expect(sonnetBreakdown!.calls).toBe(2)
    expect(sonnetBreakdown!.tokens).toBe(375) // (100+50) + (150+75)
    expect(sonnetBreakdown!.cost).toBeCloseTo(0.03, 5)

    const opusBreakdown = result!.costProfile.modelBreakdown.find((m) => m.model === "opus")
    expect(opusBreakdown).toBeDefined()
    expect(opusBreakdown!.calls).toBe(1)
    expect(opusBreakdown!.tokens).toBe(300) // 200+100
    expect(opusBreakdown!.cost).toBeCloseTo(0.05, 5)
  })

  it("builds node patterns with success rate and duration", async () => {
    seedWorkspace(db, "ws-1")
    seedExecution(db, "exec-1", "ws-1", "completed")
    seedExecution(db, "exec-2", "ws-1", "failed")

    seedNodeExecution(db, "ne-1", "exec-1", "node-1", "bash", "completed", 100)
    seedNodeExecution(db, "ne-2", "exec-2", "node-1", "bash", "failed", 200)
    seedNodeExecution(db, "ne-3", "exec-1", "node-2", "agent", "completed", 300)

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.nodePatterns).toHaveLength(2)

    const bashPattern = result!.nodePatterns.find((n) => n.node_type === "bash")
    expect(bashPattern).toBeDefined()
    expect(bashPattern!.frequency).toBe(2)
    expect(bashPattern!.successRate).toBe(0.5)
    expect(bashPattern!.avgDuration_s).toBeCloseTo(0.15, 2)

    const agentPattern = result!.nodePatterns.find((n) => n.node_type === "agent")
    expect(agentPattern).toBeDefined()
    expect(agentPattern!.frequency).toBe(1)
    expect(agentPattern!.successRate).toBe(1)
  })

  it("loads existing knowledge and truncates text", async () => {
    seedWorkspace(db, "ws-1")

    const longText = "This is a very long rule text that should be truncated".padEnd(200, "x")
    vi.mocked(listAllActiveRules).mockReturnValue([
      {
        rule_id: "rule-1",
        text: longText,
        scope: "project",
        file_name: "test.md",
        source: "test",
        date: "2024-01-01",
        retired: false,
      },
    ])

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.existingKnowledge).toHaveLength(1)
    expect(result!.existingKnowledge[0].id).toBe("rule-1")
    expect(result!.existingKnowledge[0].text.length).toBe(100)
    expect(result!.existingKnowledge[0].scope).toBe("project")
  })

  it("limits existing knowledge to MAX_KNOWLEDGE entries", async () => {
    seedWorkspace(db, "ws-1")

    const rules = Array.from({ length: 60 }, (_, i) => ({
      rule_id: `rule-${i}`,
      text: `Rule ${i}`,
      scope: "project",
      file_name: "test.md",
      source: "test",
      date: "2024-01-01",
      retired: false,
    }))

    vi.mocked(listAllActiveRules).mockReturnValue(rules)

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result!.existingKnowledge.length).toBeLessThanOrEqual(50)
  })

  it("handles knowledge loading errors gracefully", async () => {
    seedWorkspace(db, "ws-1")
    vi.mocked(listAllActiveRules).mockImplementation(() => {
      throw new Error("Filesystem error")
    })

    const result = await buildArchiveContext("ws-1", workspaceDAO, executionDAO, db, "test-org")

    expect(result).not.toBeNull()
    expect(result!.existingKnowledge).toEqual([])
  })
})
