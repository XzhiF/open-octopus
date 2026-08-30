import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ObservabilityQueryService, classifyError } from "../services/observability-query"

let db: Database.Database
let execDao: ExecutionDAO
let tokenDao: TokenUsageDAO
let service: ObservabilityQueryService

const ORG = "test-org"

function createExecution(id: string, opts?: { status?: string; budget_snapshot?: string; started_at?: string; completed_at?: string }) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, budget_snapshot, started_at, completed_at, org, created_at, updated_at)
    VALUES (?, 'ws-1', '0', 'test.yaml', 'Test', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts?.status ?? "completed", opts?.budget_snapshot ?? null, opts?.started_at ?? now, opts?.completed_at ?? now, ORG, now, now)
}

function createNodeExecution(id: string, executionId: string, opts?: {
  node_id?: string; node_type?: string; status?: string; error?: string | null
  retry_count?: number; duration?: number; parent_node_id?: string | null
  iteration_index?: number | null; started_at?: string; completed_at?: string
  exit_code?: number | null
}) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, error, retry_count, duration, parent_node_id, iteration_index, exit_code, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, executionId,
    opts?.node_id ?? id, opts?.node_type ?? "agent", opts?.status ?? "completed",
    opts?.error ?? null, opts?.retry_count ?? 0, opts?.duration ?? 1000,
    opts?.parent_node_id ?? null, opts?.iteration_index ?? null,
    opts?.exit_code ?? null,
    opts?.started_at ?? now, opts?.completed_at ?? now,
  )
}

function createLlmCall(id: string, nodeExecId: string, executionId: string, opts?: {
  node_id?: string; input_tokens?: number; output_tokens?: number
  cache_read_tokens?: number; cache_creation_tokens?: number; cost_usd?: number
  model?: string; timestamp?: number; turn_index?: number
}) {
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, model, node_id, workspace_id)
    VALUES (?, ?, ?, ?, 0, ?, 100, ?, ?, ?, ?, ?, ?, ?, 'ws-1')
  `).run(
    id, nodeExecId, executionId,
    opts?.turn_index ?? 1, opts?.timestamp ?? Date.now(),
    opts?.input_tokens ?? 100, opts?.output_tokens ?? 50,
    opts?.cache_read_tokens ?? 0, opts?.cache_creation_tokens ?? 0,
    opts?.cost_usd ?? 0.01, opts?.model ?? "claude-sonnet-4-20250514",
    opts?.node_id ?? "node-1",
  )
  // C3/Q4: summary 总量源 = ntu 账本 —— fixture 同步行（Σntu ≡ Σllm_calls，
  // 与线上 engine 路径「同一 result 双写」语义一致）
  db.prepare(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens,
      cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    `${id}-ntu`, nodeExecId, opts?.model ?? "claude-sonnet-4-20250514",
    opts?.input_tokens ?? 100, opts?.output_tokens ?? 50,
    opts?.cost_usd ?? 0.01, opts?.cache_read_tokens ?? 0, opts?.cache_creation_tokens ?? 0,
  )
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  execDao = new ExecutionDAO(db)
  tokenDao = new TokenUsageDAO(db)
  service = new ObservabilityQueryService(execDao, tokenDao)

  // Create workspace
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'Test WS', '/tmp/test', ?, datetime('now'), datetime('now'))").run(ORG)
})

// ── classifyError ──────────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies timeout errors", () => {
    expect(classifyError("Connection timeout after 30s", "agent")).toBe("timeout")
    expect(classifyError("Request timed out", "agent")).toBe("timeout")
  })

  it("classifies model errors", () => {
    expect(classifyError("Model overloaded", "agent")).toBe("model_error")
    expect(classifyError("rate_limit exceeded", "agent")).toBe("model_error")
  })

  it("classifies script errors for bash/python nodes", () => {
    expect(classifyError("Process exit with code 1", "bash", undefined, 1)).toBe("script_error")
    expect(classifyError("exit code 127", "python", undefined, 127)).toBe("script_error")
  })

  it("classifies approval_rejected", () => {
    expect(classifyError("User rejected", "approval", "rejected")).toBe("approval_rejected")
  })

  it("falls back to other", () => {
    expect(classifyError("Something went wrong", "agent")).toBe("other")
  })
})

// ── ObservabilityQueryService.getObservabilityData ─────────────────────

describe("ObservabilityQueryService", () => {
  it("throws 404 for non-existent execution", () => {
    expect(() => service.getObservabilityData("non-existent")).toThrow("Execution not found")
  })

  it("returns complete ObservabilityData structure", () => {
    createExecution("exec-1", { status: "completed" })
    createNodeExecution("ne-1", "exec-1", { node_id: "agent-1", node_type: "agent", duration: 5000 })
    createLlmCall("llm-1", "ne-1", "exec-1", { node_id: "agent-1", input_tokens: 200, output_tokens: 100, cost_usd: 0.05 })

    const data = service.getObservabilityData("exec-1")

    expect(data.executionId).toBe("exec-1")
    expect(data.status).toBe("completed")
    expect(data.tokens.usage.inputTokens).toBe(200)
    expect(data.tokens.usage.outputTokens).toBe(100)
    expect(data.tokens.totals.cost.usd).toBe(0.05)
    expect(data.byNode).toHaveLength(1)
    expect(data.byNode[0].nodeId).toBe("agent-1")
    expect(data.byNode[0].llmTurns).toBe(1)
    expect(data.byModel).toHaveLength(1)
    expect(data.byModel[0].model).toBe("claude-sonnet-4-20250514")
    expect(data.timeSeries).toHaveLength(1)
    expect(data.rounds.totalLlmTurns).toBe(1)
    expect(data.errors).toHaveLength(0)
    expect(data.budget.snapshot).toBeNull()
  })

  it("aggregates tokens correctly (AC-2)", () => {
    createExecution("exec-2")
    createNodeExecution("ne-a", "exec-2", { node_id: "n1" })
    createNodeExecution("ne-b", "exec-2", { node_id: "n2" })
    createLlmCall("llm-a1", "ne-a", "exec-2", { node_id: "n1", input_tokens: 100 })
    createLlmCall("llm-a2", "ne-a", "exec-2", { node_id: "n1", input_tokens: 150 })
    createLlmCall("llm-b1", "ne-b", "exec-2", { node_id: "n2", input_tokens: 200 })

    const data = service.getObservabilityData("exec-2")
    // SUM(input_tokens) WHERE execution_id = 'exec-2' = 100 + 150 + 200 = 450
    expect(data.tokens.usage.inputTokens).toBe(450)
  })

  it("computes byNode with correct per-node breakdown (AC-3)", () => {
    createExecution("exec-3")
    createNodeExecution("ne-1", "exec-3", { node_id: "n1", duration: 2000 })
    createNodeExecution("ne-2", "exec-3", { node_id: "n2", duration: 3000 })
    createNodeExecution("ne-3", "exec-3", { node_id: "n3", duration: 1000 })
    createLlmCall("l1", "ne-1", "exec-3", { node_id: "n1", input_tokens: 100, output_tokens: 50, cost_usd: 0.01 })
    createLlmCall("l2", "ne-2", "exec-3", { node_id: "n2", input_tokens: 200, output_tokens: 100, cost_usd: 0.02 })

    const data = service.getObservabilityData("exec-3")
    expect(data.byNode.length).toBe(3)

    const n1 = data.byNode.find(n => n.nodeId === "n1")!
    expect(n1.inputTokens).toBe(100)
    expect(n1.outputTokens).toBe(50)
    expect(n1.costUsd).toBe(0.01)
    expect(n1.llmTurns).toBe(1)
    expect(n1.durationMs).toBe(2000)
  })

  it("computes byModel correctly (AC-4)", () => {
    createExecution("exec-4")
    createNodeExecution("ne-1", "exec-4", { node_id: "n1" })
    createLlmCall("l1", "ne-1", "exec-4", { node_id: "n1", model: "claude-sonnet", input_tokens: 100, cost_usd: 0.01 })
    createLlmCall("l2", "ne-1", "exec-4", { node_id: "n1", model: "claude-sonnet", input_tokens: 200, cost_usd: 0.02 })
    createLlmCall("l3", "ne-1", "exec-4", { node_id: "n1", model: "claude-opus", input_tokens: 300, cost_usd: 0.05 })

    const data = service.getObservabilityData("exec-4")
    expect(data.byModel.length).toBe(2)

    const sonnet = data.byModel.find(m => m.model === "claude-sonnet")!
    expect(sonnet.inputTokens).toBe(300)
    expect(sonnet.costUsd).toBe(0.03)
    expect(sonnet.callCount).toBe(2)

    const opus = data.byModel.find(m => m.model === "claude-opus")!
    expect(opus.inputTokens).toBe(300)
  })

  it("computes timeSeries sorted by timestamp (AC-5)", () => {
    createExecution("exec-5")
    createNodeExecution("ne-1", "exec-5", { node_id: "n1" })
    createLlmCall("l1", "ne-1", "exec-5", { node_id: "n1", timestamp: 1000, input_tokens: 100 })
    createLlmCall("l2", "ne-1", "exec-5", { node_id: "n1", timestamp: 2000, input_tokens: 200 })
    createLlmCall("l3", "ne-1", "exec-5", { node_id: "n1", timestamp: 3000, input_tokens: 300 })

    const data = service.getObservabilityData("exec-5")
    expect(data.timeSeries.length).toBe(3)
    // Cumulative
    expect(data.timeSeries[0].cumulativeInputTokens).toBe(100)
    expect(data.timeSeries[1].cumulativeInputTokens).toBe(300)
    expect(data.timeSeries[2].cumulativeInputTokens).toBe(600)
  })

  it("classifies errors correctly (AC-6)", () => {
    createExecution("exec-6")
    createNodeExecution("ne-1", "exec-6", { node_id: "n1", error: "Connection timeout", status: "failed" })
    createNodeExecution("ne-2", "exec-6", { node_id: "n2", error: "Model overloaded", status: "failed" })
    createNodeExecution("ne-3", "exec-6", { node_id: "n3", node_type: "bash", error: "exit code 1", status: "failed", exit_code: 1 })

    const data = service.getObservabilityData("exec-6")
    expect(data.errors.length).toBe(3)
    expect(data.errors.find(e => e.nodeId === "n1")!.errorType).toBe("timeout")
    expect(data.errors.find(e => e.nodeId === "n2")!.errorType).toBe("model_error")
    expect(data.errors.find(e => e.nodeId === "n3")!.errorType).toBe("script_error")
  })

  it("computes loop iterations from child node_executions (AC-7)", () => {
    createExecution("exec-7")
    // Loop node with 3 iterations (children with iteration_index 1, 2, 3)
    createNodeExecution("ne-loop", "exec-7", { node_id: "loop-1", node_type: "loop" })
    createNodeExecution("ne-child-1", "exec-7", { node_id: "loop-1:iter-1", parent_node_id: "loop-1", iteration_index: 1 })
    createNodeExecution("ne-child-2", "exec-7", { node_id: "loop-1:iter-2", parent_node_id: "loop-1", iteration_index: 2 })
    createNodeExecution("ne-child-3", "exec-7", { node_id: "loop-1:iter-3", parent_node_id: "loop-1", iteration_index: 3 })

    const data = service.getObservabilityData("exec-7")

    const loopNode = data.byNode.find(n => n.nodeId === "loop-1")!
    expect(loopNode.loopIterations).toBe(3)

    expect(data.rounds.totalLoopIterations).toBe(3)
  })

  it("computes budget progress from snapshot (AC-8)", () => {
    createExecution("exec-8", {
      budget_snapshot: JSON.stringify({ max_tokens: 1000, max_cost_usd: 1.0, alert_threshold: 0.8 }),
      started_at: new Date(Date.now() - 60000).toISOString(),
    })
    createNodeExecution("ne-1", "exec-8", { node_id: "n1" })
    createLlmCall("l1", "ne-1", "exec-8", { node_id: "n1", input_tokens: 500, output_tokens: 200, cost_usd: 0.5 })

    const data = service.getObservabilityData("exec-8")
    expect(data.budget.snapshot).toEqual({ max_tokens: 1000, max_cost_usd: 1.0, alert_threshold: 0.8 })

    // tokens: (500 + 200 + 0) / 1000 = 70%
    expect(data.budget.progress.tokensPercent).toBe(70)
    // cost: 0.5 / 1.0 = 50%
    expect(data.budget.progress.costPercent).toBe(50)
  })

  it("returns null progress when no budget snapshot", () => {
    createExecution("exec-9")
    createNodeExecution("ne-1", "exec-9", { node_id: "n1" })

    const data = service.getObservabilityData("exec-9")
    expect(data.budget.snapshot).toBeNull()
    expect(data.budget.progress.tokensPercent).toBeNull()
    expect(data.budget.progress.durationPercent).toBeNull()
    expect(data.budget.progress.costPercent).toBeNull()
  })

  it("generates alerts when threshold is exceeded", () => {
    createExecution("exec-10", {
      budget_snapshot: JSON.stringify({ max_tokens: 1000, alert_threshold: 0.8 }),
    })
    createNodeExecution("ne-1", "exec-10", { node_id: "n1" })
    // Total tokens: 800 + 100 = 900 > 1000 * 0.8 = 800
    createLlmCall("l1", "ne-1", "exec-10", { node_id: "n1", input_tokens: 800, output_tokens: 100 })

    const data = service.getObservabilityData("exec-10")
    expect(data.budget.alerts.length).toBeGreaterThan(0)
    expect(data.budget.alerts[0].metric).toBe("tokens")
    expect(data.budget.alerts[0].type).toBe("warning")
  })

  it("computes retry count from node_executions", () => {
    createExecution("exec-11")
    createNodeExecution("ne-1", "exec-11", { node_id: "n1", retry_count: 2 })

    const data = service.getObservabilityData("exec-11")
    expect(data.rounds.totalRetries).toBe(2)
    expect(data.byNode[0].retryCount).toBe(2)
  })
})
