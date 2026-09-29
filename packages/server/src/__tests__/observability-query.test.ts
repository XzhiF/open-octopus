// P1 B4 票2B-1：ObservabilityQueryService 双 DAO —— execDao（ExecutionDAO，B5 批）仍 SQLite，
// tokenDao（TokenUsageDAO）已迁 PG。fixture 因此两侧镜像造数：
//   sqlite: executions / node_executions（execDao 读路径）
//   PG:     workspaces / executions / node_executions / node_token_usages / llm_calls /
//           billing_price_config（aggregateByExecution 的 ntu JOIN 与派生视图读路径）
// getObservabilityData 已 async 化；用例语义与条数逐条保持。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ObservabilityQueryService, classifyError } from "../services/observability-query"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

let db: Database.Database
let pg: PgFixture
let execDao: ExecutionDAO
let tokenDao: TokenUsageDAO
let service: ObservabilityQueryService

const ORG = "test-org"

async function createExecution(id: string, opts?: { status?: string; budget_snapshot?: string; started_at?: string; completed_at?: string }) {
  const now = new Date().toISOString()
  const status = opts?.status ?? "completed"
  const started = opts?.started_at ?? now
  const completed = opts?.completed_at ?? now
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, budget_snapshot, started_at, completed_at, org, created_at, updated_at)
    VALUES (?, 'ws-1', '0', 'test.yaml', 'Test', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, status, opts?.budget_snapshot ?? null, started, completed, ORG, now, now)
  // PG 镜像（aggregateByExecution 的 node_executions JOIN executions 在 PG 侧执行；
  // PG executions 有 FK → workspaces，父行由 beforeEach 镜像造好）
  await pg.sql.unsafe(`
    INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ($1, 'ws-1', '0', 'test.yaml', 'Test', $2, $3, $4, $5, $6, $6)
  `, [id, status, started, completed, ORG, now])
}

async function createNodeExecution(id: string, executionId: string, opts?: {
  node_id?: string; node_type?: string; status?: string; error?: string | null
  retry_count?: number; duration?: number; parent_node_id?: string | null
  iteration_index?: number | null; started_at?: string; completed_at?: string
  exit_code?: number | null
}) {
  const now = new Date().toISOString()
  const values = [
    opts?.node_id ?? id, opts?.node_type ?? "agent", opts?.status ?? "completed",
    opts?.error ?? null, opts?.retry_count ?? 0, opts?.duration ?? 1000,
    opts?.parent_node_id ?? null, opts?.iteration_index ?? null,
    opts?.exit_code ?? null,
    opts?.started_at ?? now, opts?.completed_at ?? now,
  ]
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, error, retry_count, duration, parent_node_id, iteration_index, exit_code, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, executionId, ...values)
  await pg.sql.unsafe(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, error, retry_count, duration, parent_node_id, iteration_index, exit_code, started_at, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [id, executionId, ...values])
}

let __ocqSeq = 0
async function createLlmCall(id: string, nodeExecId: string, executionId: string, opts?: {
  node_id?: string; input_tokens?: number; output_tokens?: number
  cache_read_tokens?: number; cache_creation_tokens?: number; cost_usd?: number
  model?: string; timestamp?: number; turn_index?: number
}) {
  const model = opts?.model ?? "claude-sonnet-4-20250514"
  const inp = opts?.input_tokens ?? 100
  const out = opts?.output_tokens ?? 50
  const ts = opts?.timestamp ?? (Date.now() + (++__ocqSeq)) // 每行唯一时刻 → 精确窗口互不重叠
  const cost = opts?.cost_usd ?? 0.01
  const cacheR = opts?.cache_read_tokens ?? 0
  const cacheC = opts?.cache_creation_tokens ?? 0
  const turn = opts?.turn_index ?? 1
  const nodeId = opts?.node_id ?? "node-1"
  // NEW-r2:钱不落账本 —— 逐行造「恰命中该笔时刻」的窗口价（仅按 input 计费,
  // 单价 = cost×1e6/input），派生结果与旧 cost_usd 字面量一致。
  db.prepare(`INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price,
      output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES (?, 'v', ?, ?, 0, 0, 0, 'USD', ?, ?, 't', 't')`)
    .run(`pp-${id}`, model, (inp > 0 ? cost : 0) * 1e6 / inp, ts, ts + 1)
  await pg.sql.unsafe(`INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price,
      output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES ($1, 'v', $2, $3, 0, 0, 0, 'USD', $4, $5, now(), now())`,
    [`pp-${id}`, model, (inp > 0 ? cost : 0) * 1e6 / inp, ts, ts + 1])
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, node_id, workspace_id, source_path)
    VALUES (?, ?, ?, ?, 0, ?, 100, ?, ?, ?, ?, ?, ?, 'ws-1', 'workflow')
  `).run(id, nodeExecId, executionId, turn, ts, inp, out, cacheR, cacheC, model, nodeId)
  await pg.sql.unsafe(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, node_id, workspace_id, source_path)
    VALUES ($1, $2, $3, $4, 0, $5, 100, $6, $7, $8, $9, $10, $11, 'ws-1', 'workflow')
  `, [id, nodeExecId, executionId, turn, ts, inp, out, cacheR, cacheC, model, nodeId])
  // C3/Q4: summary 总量源 = ntu 账本 —— fixture 同步行（Σntu ≡ Σllm_calls，
  // 与线上 engine 路径「同一 result 双写」语义一致）。NEW-r2:ntu 无 cost 列。
  db.prepare(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(`${id}-ntu`, nodeExecId, model, inp, out, cacheR, cacheC)
  await pg.sql.unsafe(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now())
  `, [`${id}-ntu`, nodeExecId, model, inp, out, cacheR, cacheC])
}

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

describePg("ObservabilityQueryService", () => {
  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    pg = await setupPgSchema()
    execDao = new ExecutionDAO(db)
    tokenDao = new TokenUsageDAO(pg.sql)
    service = new ObservabilityQueryService(execDao, tokenDao)

    // Create workspace（两侧：sqlite execDao + PG executions FK 父行）
    db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'Test WS', '/tmp/test', ?, datetime('now'), datetime('now'))").run(ORG)
    await pg.sql.unsafe("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'Test WS', '/tmp/test', $1, now(), now())", [ORG])
  })

  afterEach(async () => {
    db.close()
    await pg.close()
  })

  it("throws 404 for non-existent execution", async () => {
    await expect(service.getObservabilityData("non-existent")).rejects.toThrow("Execution not found")
  })

  it("returns complete ObservabilityData structure", async () => {
    await createExecution("exec-1", { status: "completed" })
    await createNodeExecution("ne-1", "exec-1", { node_id: "agent-1", node_type: "agent", duration: 5000 })
    await createLlmCall("llm-1", "ne-1", "exec-1", { node_id: "agent-1", input_tokens: 200, output_tokens: 100, cost_usd: 0.05 })

    const data = await service.getObservabilityData("exec-1")

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

  it("aggregates tokens correctly (AC-2)", async () => {
    await createExecution("exec-2")
    await createNodeExecution("ne-a", "exec-2", { node_id: "n1" })
    await createNodeExecution("ne-b", "exec-2", { node_id: "n2" })
    await createLlmCall("llm-a1", "ne-a", "exec-2", { node_id: "n1", input_tokens: 100 })
    await createLlmCall("llm-a2", "ne-a", "exec-2", { node_id: "n1", input_tokens: 150 })
    await createLlmCall("llm-b1", "ne-b", "exec-2", { node_id: "n2", input_tokens: 200 })

    const data = await service.getObservabilityData("exec-2")
    // SUM(input_tokens) WHERE execution_id = 'exec-2' = 100 + 150 + 200 = 450
    expect(data.tokens.usage.inputTokens).toBe(450)
  })

  it("computes byNode with correct per-node breakdown (AC-3)", async () => {
    await createExecution("exec-3")
    await createNodeExecution("ne-1", "exec-3", { node_id: "n1", duration: 2000 })
    await createNodeExecution("ne-2", "exec-3", { node_id: "n2", duration: 3000 })
    await createNodeExecution("ne-3", "exec-3", { node_id: "n3", duration: 1000 })
    await createLlmCall("l1", "ne-1", "exec-3", { node_id: "n1", input_tokens: 100, output_tokens: 50, cost_usd: 0.01 })
    await createLlmCall("l2", "ne-2", "exec-3", { node_id: "n2", input_tokens: 200, output_tokens: 100, cost_usd: 0.02 })

    const data = await service.getObservabilityData("exec-3")
    expect(data.byNode.length).toBe(3)

    const n1 = data.byNode.find(n => n.nodeId === "n1")!
    expect(n1.inputTokens).toBe(100)
    expect(n1.outputTokens).toBe(50)
    expect(n1.costUsd).toBe(0.01)
    expect(n1.llmTurns).toBe(1)
    expect(n1.durationMs).toBe(2000)
  })

  it("computes byModel correctly (AC-4)", async () => {
    await createExecution("exec-4")
    await createNodeExecution("ne-1", "exec-4", { node_id: "n1" })
    await createLlmCall("l1", "ne-1", "exec-4", { node_id: "n1", model: "claude-sonnet", input_tokens: 100, cost_usd: 0.01 })
    await createLlmCall("l2", "ne-1", "exec-4", { node_id: "n1", model: "claude-sonnet", input_tokens: 200, cost_usd: 0.02 })
    await createLlmCall("l3", "ne-1", "exec-4", { node_id: "n1", model: "claude-opus", input_tokens: 300, cost_usd: 0.05 })

    const data = await service.getObservabilityData("exec-4")
    expect(data.byModel.length).toBe(2)

    const sonnet = data.byModel.find(m => m.model === "claude-sonnet")!
    expect(sonnet.inputTokens).toBe(300)
    expect(sonnet.costUsd).toBe(0.03)
    expect(sonnet.callCount).toBe(2)

    const opus = data.byModel.find(m => m.model === "claude-opus")!
    expect(opus.inputTokens).toBe(300)
  })

  it("computes timeSeries sorted by timestamp (AC-5)", async () => {
    await createExecution("exec-5")
    await createNodeExecution("ne-1", "exec-5", { node_id: "n1" })
    await createLlmCall("l1", "ne-1", "exec-5", { node_id: "n1", timestamp: 1000, input_tokens: 100 })
    await createLlmCall("l2", "ne-1", "exec-5", { node_id: "n1", timestamp: 2000, input_tokens: 200 })
    await createLlmCall("l3", "ne-1", "exec-5", { node_id: "n1", timestamp: 3000, input_tokens: 300 })

    const data = await service.getObservabilityData("exec-5")
    expect(data.timeSeries.length).toBe(3)
    // Cumulative
    expect(data.timeSeries[0].cumulativeInputTokens).toBe(100)
    expect(data.timeSeries[1].cumulativeInputTokens).toBe(300)
    expect(data.timeSeries[2].cumulativeInputTokens).toBe(600)
  })

  it("classifies errors correctly (AC-6)", async () => {
    await createExecution("exec-6")
    await createNodeExecution("ne-1", "exec-6", { node_id: "n1", error: "Connection timeout", status: "failed" })
    await createNodeExecution("ne-2", "exec-6", { node_id: "n2", error: "Model overloaded", status: "failed" })
    await createNodeExecution("ne-3", "exec-6", { node_id: "n3", node_type: "bash", error: "exit code 1", status: "failed", exit_code: 1 })

    const data = await service.getObservabilityData("exec-6")
    expect(data.errors.length).toBe(3)
    expect(data.errors.find(e => e.nodeId === "n1")!.errorType).toBe("timeout")
    expect(data.errors.find(e => e.nodeId === "n2")!.errorType).toBe("model_error")
    expect(data.errors.find(e => e.nodeId === "n3")!.errorType).toBe("script_error")
  })

  it("computes loop iterations from child node_executions (AC-7)", async () => {
    await createExecution("exec-7")
    // Loop node with 3 iterations (children with iteration_index 1, 2, 3)
    await createNodeExecution("ne-loop", "exec-7", { node_id: "loop-1", node_type: "loop" })
    await createNodeExecution("ne-child-1", "exec-7", { node_id: "loop-1:iter-1", parent_node_id: "loop-1", iteration_index: 1 })
    await createNodeExecution("ne-child-2", "exec-7", { node_id: "loop-1:iter-2", parent_node_id: "loop-1", iteration_index: 2 })
    await createNodeExecution("ne-child-3", "exec-7", { node_id: "loop-1:iter-3", parent_node_id: "loop-1", iteration_index: 3 })

    const data = await service.getObservabilityData("exec-7")

    const loopNode = data.byNode.find(n => n.nodeId === "loop-1")!
    expect(loopNode.loopIterations).toBe(3)

    expect(data.rounds.totalLoopIterations).toBe(3)
  })

  it("computes budget progress from snapshot (AC-8)", async () => {
    await createExecution("exec-8", {
      budget_snapshot: JSON.stringify({ max_tokens: 1000, max_cost_usd: 1.0, alert_threshold: 0.8 }),
      started_at: new Date(Date.now() - 60000).toISOString(),
    })
    await createNodeExecution("ne-1", "exec-8", { node_id: "n1" })
    await createLlmCall("l1", "ne-1", "exec-8", { node_id: "n1", input_tokens: 500, output_tokens: 200, cost_usd: 0.5 })

    const data = await service.getObservabilityData("exec-8")
    expect(data.budget.snapshot).toEqual({ max_tokens: 1000, max_cost_usd: 1.0, alert_threshold: 0.8 })

    // tokens: (500 + 200 + 0) / 1000 = 70%
    expect(data.budget.progress.tokensPercent).toBe(70)
    // cost: 0.5 / 1.0 = 50%
    expect(data.budget.progress.costPercent).toBe(50)
  })

  it("returns null progress when no budget snapshot", async () => {
    await createExecution("exec-9")
    await createNodeExecution("ne-1", "exec-9", { node_id: "n1" })

    const data = await service.getObservabilityData("exec-9")
    expect(data.budget.snapshot).toBeNull()
    expect(data.budget.progress.tokensPercent).toBeNull()
    expect(data.budget.progress.durationPercent).toBeNull()
    expect(data.budget.progress.costPercent).toBeNull()
  })

  it("generates alerts when threshold is exceeded", async () => {
    await createExecution("exec-10", {
      budget_snapshot: JSON.stringify({ max_tokens: 1000, alert_threshold: 0.8 }),
    })
    await createNodeExecution("ne-1", "exec-10", { node_id: "n1" })
    // Total tokens: 800 + 100 = 900 > 1000 * 0.8 = 800
    await createLlmCall("l1", "ne-1", "exec-10", { node_id: "n1", input_tokens: 800, output_tokens: 100 })

    const data = await service.getObservabilityData("exec-10")
    expect(data.budget.alerts.length).toBeGreaterThan(0)
    expect(data.budget.alerts[0].metric).toBe("tokens")
    expect(data.budget.alerts[0].type).toBe("warning")
  })

  it("computes retry count from node_executions", async () => {
    await createExecution("exec-11")
    await createNodeExecution("ne-1", "exec-11", { node_id: "n1", retry_count: 2 })

    const data = await service.getObservabilityData("exec-11")
    expect(data.rounds.totalRetries).toBe(2)
    expect(data.byNode[0].retryCount).toBe(2)
  })
})
