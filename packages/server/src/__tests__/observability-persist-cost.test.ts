import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ObservabilityService } from "../services/observability"
import { __setPricingOverlayForTest, __resetPricingOverlayForTest } from "@octopus/shared"
import type { LLMCallRecord } from "@octopus/providers"
import type { AgentEvent } from "@octopus/engine"

/**
 * C2 行为钉：llm_calls.cost_usd 落库三态 ——
 * 未定价 → NULL（旧行为是按 default=sonnet 假计费）；
 * 价表命中（SDK 0 价已被 seam 归一）→ 估算值；SDK 真给了价 → 原样。
 */
let db: Database.Database
let svc: ObservabilityService

const META = { executionId: "e1", nodeId: "n1", org: "test-org", workspaceId: "ws-1", workflowRef: "t.yaml" }

function record(over: Partial<LLMCallRecord>): LLMCallRecord {
  return {
    turnIndex: 1, messageId: "m1", timestamp: Date.now(), durationMs: 100,
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100,
    ...over,
  } as LLMCallRecord
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const now = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'Test WS', '/tmp/test', 'test-org', datetime('now'), datetime('now'))").run()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e1', 'ws-1', '0', 't.yaml', 'T', 'completed', ?, ?, 'test-org', ?, ?)
  `).run(now, now, now, now)
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES ('e1-n1', 'e1', 'n1', 'agent', 'completed', 0, 1000, ?, ?)
  `).run(now, now)
  // overlay 钉成 models.yaml 内容示意：qwen3.8-flash 有价，qwen3.7-max 没有
  __setPricingOverlayForTest({ "qwen3.8-flash": { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.5 } })
  svc = new ObservabilityService(new ExecutionDAO(db), new TokenUsageDAO(db))
  svc.bufferEvent("e1-n1", { type: "heartbeat", data: {} } as unknown as AgentEvent, META as never)
})

afterEach(() => {
  __resetPricingOverlayForTest()
  db.close()
})

function persistedCost(model: string, over: Partial<LLMCallRecord> = {}): number | null {
  svc.persistLLMCalls("e1-n1", "e1", [record({ model, ...over })], "inst-1")
  const row = db.prepare("SELECT cost_usd FROM llm_calls WHERE model = ?").get(model) as { cost_usd: number | null } | undefined
  if (!row) throw new Error(`llm_calls 行未落库: model=${model}`) // 区分 NULL 与缺行
  return row.cost_usd
}

describe("llm_calls.cost_usd 落库三态 (C2)", () => {
  it("未定价模型（qwen3.7-max，无 SDK cost）→ NULL，不再被 sonnet 假价接住", () => {
    expect(persistedCost("qwen3.7-max")).toBeNull()
  })

  it("models.yaml 补价 + 变体后缀：qwen3.8-flash[1m] → 按配置价估算", () => {
    // (1000*1 + 500*2 + 200*0.1 + 100*0.5)/1e6 = 2070/1e6
    expect(persistedCost("qwen3.8-flash[1m]")).toBeCloseTo(0.00207, 12)
  })

  it("内置 Claude 档：SDK 未给 cost → 价表估算兜底", () => {
    // (1000*3 + 500*15 + 200*0.3 + 100*3.75)/1e6 = 10935/1e6
    expect(persistedCost("claude-sonnet-4-5-20250827")).toBeCloseTo(0.010935, 12)
  })

  it("上游给了真实 costUsd → 原样落库，不被估算覆盖", () => {
    expect(persistedCost("claude-sonnet-4-5-20250827", { costUsd: 0.042 })).toBe(0.042)
  })
})
