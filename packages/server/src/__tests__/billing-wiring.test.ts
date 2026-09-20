// 04 · 记账接线回归（billing-core-1 ticket 04）
// Seam: TokenUsageDAO.recordNodeUsage / insertLlmCall / insertLlmCallBatch ——
// 全站唯一记账写入口，cost 只经 BillingService 产出（KD2/KD4/KD5/KD11）。
// 期望值手算：1M×(in,out,cw,cr) × CNY {21,105,26,2} → native=154；/7 → usd=22；
// ×USD {3,15,3.75,0.3} → 22.05；1000in/500out × USD {3,15,...} → (3000+7500)/1e6=0.0105。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import type { LlmCallRow } from "../db/types"

let db: Database.Database
let dao: TokenUsageDAO
let billing: BillingDAO

const now = () => new Date().toISOString()
const usage4 = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const t = now()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/w','o',?,?)").run(t, t)
  db.prepare("INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at) VALUES ('e-1','ws-1','0','t.yaml','T','completed',?,?,?,?,?)").run(t, t, 'o', t, t)
  db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('ne-1','e-1','n1','agent','completed',0,1,?,?)").run(t, t)
  dao = new TokenUsageDAO(db)
  billing = new BillingDAO(db)
})

afterEach(() => {
  db.close()
})

function ntuRow(id: string) {
  return db.prepare("SELECT * FROM node_token_usages WHERE id = ?").get(id) as { cost_usd: number | null }
}

describe("recordNodeUsage — cost 唯一来源 = BillingService（票04 规则1/2/3）", () => {
  it("配价模型 → ntu.cost_usd = BillingService USD 归一值（CNY 154/7=22）", () => {
    billing.createPrice({ id: "W-cny", vendor: "e2e", model_id: "E2E_TEST_wired-cny", input_unit_price: 21, output_unit_price: 105, cache_write_unit_price: 26, cache_read_unit_price: 2, currency: "CNY" })
    dao.recordNodeUsage({ id: "w1", nodeExecutionId: "ne-1", model: "E2E_TEST_wired-cny", usage: usage4, source: "node", createdAt: now() })
    expect(ntuRow("w1").cost_usd).toBeCloseTo(22, 6) // 手算 (21+105+26+2)/7 = 22
  })

  it("SDK 上报 costUsd 被忽略，不落账（KD2）", () => {
    billing.createPrice({ id: "W-usd", vendor: "e2e", model_id: "E2E_TEST_wired-usd", input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3, currency: "USD" })
    dao.recordNodeUsage({ id: "w2", nodeExecutionId: "ne-1", model: "E2E_TEST_wired-usd", usage: usage4, costUsd: 999.99, source: "node", createdAt: now() })
    expect(ntuRow("w2").cost_usd).toBeCloseTo(22.05, 10) // 3+15+3.75+0.3，SDK 的 999.99 不进门
  })

  it("未配价模型 → NULL（KD4 不估算、不焊 0）", () => {
    dao.recordNodeUsage({ id: "w3", nodeExecutionId: "ne-1", model: "E2E_TEST_unpriced-any", usage: usage4, costUsd: 1.5, source: "node", createdAt: now() })
    expect(ntuRow("w3").cost_usd).toBeNull()
  })

  it("harness/interaction source 同走此入口（规则3 覆盖全 source）", () => {
    billing.createPrice({ id: "W-src", vendor: "e2e", model_id: "E2E_TEST_wired-src", input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3, currency: "USD" })
    dao.recordNodeUsage({ id: "w4", nodeExecutionId: "ne-1", model: "E2E_TEST_wired-src", usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 }, source: "harness", createdAt: now() })
    dao.recordNodeUsage({ id: "w5", nodeExecutionId: "ne-1", model: "E2E_TEST_wired-src", usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 }, source: "interaction", createdAt: now() })
    expect(ntuRow("w4").cost_usd).toBeCloseTo(0.0105, 12) // (1000*3+500*15)/1e6
    expect(ntuRow("w5").cost_usd).toBeCloseTo(0.0105, 12)
  })
})

describe("llm_calls 三新列随写入口落库（票04 规则1）", () => {
  function callRow(over: Partial<LlmCallRow>): LlmCallRow {
    return {
      id: over.id ?? "c1", node_execution_id: "ne-1", execution_id: "e-1", turn_index: 1, call_index: 0,
      message_id: null, model: "E2E_TEST_wired-usd", stop_reason: null, timestamp: Date.now(), duration_ms: 100,
      ttft_ms: null, input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000, cost_usd: null, org: null, workspace_id: "ws-1",
      workflow_ref: null, node_id: "n1", session_id: null, instance_id: null, ...over,
    }
  }

  it("insertLlmCall + insertLlmCallBatch 把 cost_native/cost_currency/price_status 原样落库", () => {
    billing.createPrice({ id: "W-i", vendor: "e2e", model_id: "E2E_TEST_wired-usd", input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3, currency: "USD" })
    dao.insertLlmCall(callRow({ id: "b1", cost_usd: 22.05, cost_native: 22.05, cost_currency: "USD", price_status: "priced" }))
    const r = db.prepare("SELECT cost_usd, cost_native, cost_currency, price_status FROM llm_calls WHERE id='b1'").get() as { cost_usd: number; cost_native: number; cost_currency: string; price_status: string }
    expect(r).toEqual({ cost_usd: 22.05, cost_native: 22.05, cost_currency: "USD", price_status: "priced" })

    dao.insertLlmCallBatch([callRow({ id: "b2", price_status: "unpriced", cost_native: null, cost_currency: null })])
    const r2 = db.prepare("SELECT cost_usd, cost_native, cost_currency, price_status FROM llm_calls WHERE id='b2'").get() as { cost_usd: number | null; cost_native: number | null; cost_currency: string | null; price_status: string | null }
    expect(r2).toEqual({ cost_usd: null, cost_native: null, cost_currency: null, price_status: "unpriced" })
  })

  it("未带三列的旧式插入不受破坏（列默认 NULL，零破坏 KD5）", () => {
    dao.insertLlmCall(callRow({ id: "b3" }))
    const r = db.prepare("SELECT cost_usd, cost_native, cost_currency, price_status FROM llm_calls WHERE id='b3'").get() as Record<string, unknown>
    expect(r.cost_native).toBeNull()
    expect(r.price_status).toBeNull()
  })
})

describe("AC1 · 记账写路径源码无 MODEL_PRICING/computeCostFromTokens/价表兜底", () => {
  const writePathFiles = [
    "../services/execution/EngineCallbacks.ts",
    "../services/observability.ts",
    "../services/interaction/InteractionService.ts",
    "../services/harness/agent-delegation.ts",
    "../db/dao/token-usage-dao.ts",
    "../db/dao/usage-ledger.ts",
  ]
  for (const rel of writePathFiles) {
    it(`${path.basename(rel)} 干净`, () => {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8")
      expect(src).not.toMatch(/MODEL_PRICING|computeCostFromTokens|estimateCost|priceFor|ledgerCostUsd/)
    })
  }
})
