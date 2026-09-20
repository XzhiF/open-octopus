import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { ObservabilityService } from "../services/observability"
import type { LLMCallRecord } from "@octopus/providers"
import type { AgentEvent } from "@octopus/engine"

/**
 * billing-core-1 票04 —— llm_calls 落库 cost 语义钉（换源后）：
 * 唯一来源 = BillingService（billing_price_config + 记账时刻汇率）。
 * 未配价 → 三列 NULL + unpriced（KD4 不估算）；SDK 上报价不作账（KD2）。
 * 期望值手算：record 默认量 in=1000/out=500/cr=200/cc=100 ——
 *   USD {3,15,3.75,0.3}: 1000×3+500×15+100×3.75(cc→cache_write)+200×0.3(cr) = 3000+7500+375+60 = 10935 → 0.010935；
 *   CNY {21,105,26,2}: 21000+52500+2600+400 = 76500 → native 0.0765；/7 = 0.010928571428571428。
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
  svc = new ObservabilityService(new ExecutionDAO(db), new TokenUsageDAO(db))
  svc.bufferEvent("e1-n1", { type: "heartbeat", data: {} } as unknown as AgentEvent, META as never)
})

afterEach(() => {
  db.close()
})

function persistedRow(model: string, over: Partial<LLMCallRecord> = {}) {
  svc.persistLLMCalls("e1-n1", "e1", [record({ model, ...over })], "inst-1")
  const row = db.prepare(
    "SELECT cost_usd, cost_native, cost_currency, price_status FROM llm_calls WHERE model = ?",
  ).get(model) as { cost_usd: number | null; cost_native: number | null; cost_currency: string | null; price_status: string | null } | undefined
  if (!row) throw new Error(`llm_calls 行未落库: model=${model}`) // 区分 NULL 与缺行
  return row
}

function price(modelId: string, p: [number, number, number, number], currency: "USD" | "CNY") {
  new BillingDAO(db).createPrice({
    id: `OC-${modelId}`, vendor: "e2e", model_id: modelId,
    input_unit_price: p[0], output_unit_price: p[1], cache_write_unit_price: p[2], cache_read_unit_price: p[3],
    currency,
  })
}

describe("llm_calls 落库 cost —— BillingService 唯一来源（票04/KD2/KD4/KD5）", () => {
  it("未配价模型 → cost 三列 NULL + unpriced（shared 价表兜底已下线，不估算）", () => {
    expect(persistedRow("qwen3.7-max")).toEqual({
      cost_usd: null, cost_native: null, cost_currency: null, price_status: "unpriced",
    })
  })

  it("配价 USD {3,15,3.75,0.3} → native=usd=0.010935, priced, cost_currency=USD", () => {
    price("E2E_TEST_obs-usd", [3, 15, 3.75, 0.3], "USD")
    expect(persistedRow("E2E_TEST_obs-usd")).toEqual({
      cost_usd: expect.closeTo(0.010935, 12),
      cost_native: expect.closeTo(0.010935, 12),
      cost_currency: "USD",
      price_status: "priced",
    })
  })

  it("配价 CNY {21,105,26,2}（默认汇率 7.0）→ native=0.0765；usd=0.0765/7 归一", () => {
    price("E2E_TEST_obs-cny", [21, 105, 26, 2], "CNY")
    const r = persistedRow("E2E_TEST_obs-cny")
    expect(r.cost_native).toBeCloseTo(0.0765, 12) // 21000+52500+2600+400 = 76500 /1e6
    expect(r.cost_currency).toBe("CNY")
    expect(r.cost_usd).toBeCloseTo(0.010928571428571428, 12) // 0.0765/7 手算
    expect(r.price_status).toBe("priced")
  })

  it("SDK 上报 costUsd 不作账（KD2）：配价行 → 用公式值；未配价 → 仍 NULL", () => {
    price("E2E_TEST_obs-sdk", [3, 15, 3.75, 0.3], "USD")
    expect(persistedRow("E2E_TEST_obs-sdk", { costUsd: 999.99 }).cost_usd).toBeCloseTo(0.010935, 12)
    expect(persistedRow("E2E_TEST_obs-none", { costUsd: 999.99 }).cost_usd).toBeNull()
  })
})
