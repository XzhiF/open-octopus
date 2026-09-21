import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { ObservabilityService } from "../services/observability"
import { recordLlmCall, type LlmCallLedgerInput } from "../services/llm-call-ledger"
import type { LlmCallSourcePath } from "@octopus/shared"
import type { LLMCallRecord } from "@octopus/providers"
import type { AgentEvent } from "@octopus/engine"

/**
 * billing-coverage-2 票01 —— 共用落账 helper（单一函数，所有路径经它写 llm_calls）。
 * 手算期望（同 phase 1 票04 口径）：量 in=1000/out=500/cr=200/cc=100，
 * USD {3,15,3.75,0.3}: 1000×3+500×15+100×3.75+200×0.3 = 10935 /1e6 = 0.010935。
 */
let db: Database.Database
let dao: TokenUsageDAO

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
  dao = new TokenUsageDAO(db)
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
  new BillingDAO(db).createPrice({
    id: "OC-ledger-usd", vendor: "e2e", model_id: "E2E_TEST_ledger-usd",
    input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
    currency: "USD",
  })
})

afterEach(() => {
  db.close()
})

function fullInput(over: Partial<LlmCallLedgerInput> = {}): LlmCallLedgerInput {
  return {
    id: "call-1",
    sourcePath: "clone_chat",
    nodeExecutionId: "e1-n1",
    executionId: "e1",
    turnIndex: 2,
    callIndex: 1,
    model: "E2E_TEST_ledger-usd",
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 },
    timestamp: 1700000000000,
    durationMs: 420,
    messageId: "m1",
    stopReason: "end_turn",
    ttftMs: 90,
    org: "test-org",
    workspaceId: "ws-1",
    workflowRef: null,
    nodeId: "n1",
    sessionId: "sess-9",
    instanceId: "inst-1",
    ...over,
  }
}

function row(id: string) {
  return db.prepare("SELECT * FROM llm_calls WHERE id = ?").get(id) as Record<string, unknown>
}

describe("共用落账 helper —— recordLlmCall（票01）", () => {
  it("四类 token + 归属维度 + 来源如实落库；cost 经 BillingService 手算一致", () => {
    recordLlmCall(fullInput(), dao)
    expect(row("call-1")).toMatchObject({
      source_path: "clone_chat",
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
      model: "E2E_TEST_ledger-usd",
      node_execution_id: "e1-n1", execution_id: "e1", turn_index: 2, call_index: 1,
      message_id: "m1", stop_reason: "end_turn", timestamp: 1700000000000,
      duration_ms: 420, ttft_ms: 90, org: "test-org", workspace_id: "ws-1",
      node_id: "n1", session_id: "sess-9", instance_id: "inst-1",
      cost_usd: expect.closeTo(0.010935, 12),
      cost_native: expect.closeTo(0.010935, 12),
      cost_currency: "USD", price_status: "priced",
    })
  })

  it("未配价 → cost 三列 NULL + unpriced（复用 phase 1 KD4，不另算）", () => {
    recordLlmCall(fullInput({ id: "call-2", model: "E2E_TEST_noprice" }), dao)
    expect(row("call-2")).toMatchObject({
      cost_usd: null, cost_native: null, cost_currency: null, price_status: "unpriced",
      source_path: "clone_chat",
    })
  })

  it("七枚举值全部可写（AC2 合法域）", () => {
    const all: LlmCallSourcePath[] = ["workflow", "interaction", "harness", "clone_chat", "global_chat", "session_compress", "unknown"]
    all.forEach((p, i) => recordLlmCall(fullInput({ id: `call-enum-${i}`, sourcePath: p }), dao))
    const got = (db.prepare(
      "SELECT source_path FROM llm_calls WHERE id LIKE 'call-enum-%' ORDER BY CAST(substr(id, 11) AS INTEGER)",
    ).all() as Array<{ source_path: string }>).map(r => r.source_path)
    expect(got).toEqual(all)
  })

  it("非法 source_path → 直接抛（不落库，AC2 防线）", () => {
    expect(() => recordLlmCall(fullInput({ sourcePath: "bogus_path" as LlmCallSourcePath }), dao)).toThrow(/source_path/)
    expect(db.prepare("SELECT COUNT(*) c FROM llm_calls").get()).toEqual({ c: 0 })
  })
})

describe("既有写入点收敛改造（票01 第3条：行为等价）", () => {
  it("observability（workflow 路径，EngineCallbacks 经此写 llm_calls）→ 行仍落库且 source_path='workflow'，cost 口径不变", () => {
    const svc = new ObservabilityService(new ExecutionDAO(db), dao)
    svc.bufferEvent("e1-n1", { type: "heartbeat", data: {} } as unknown as AgentEvent, META as never)
    svc.persistLLMCalls("e1-n1", "e1", [record({ model: "E2E_TEST_ledger-usd" })], "inst-1")
    const r = db.prepare(
      "SELECT source_path, cost_usd, cost_currency, price_status, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, workflow_ref, execution_id, instance_id FROM llm_calls",
    ).get() as Record<string, unknown>
    expect(r).toEqual({
      source_path: "workflow",
      cost_usd: expect.closeTo(0.010935, 12),
      cost_currency: "USD", price_status: "priced",
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
      workflow_ref: "t.yaml", execution_id: "e1", instance_id: "inst-1",
    })
  })
})
