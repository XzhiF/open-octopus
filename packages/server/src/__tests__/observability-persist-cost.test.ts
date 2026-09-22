import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { ObservabilityService } from "../services/observability"
import { loadFeatureFlags } from "../config/feature-flags"
import type { LLMCallRecord } from "@octopus/providers"
import type { AgentEvent } from "@octopus/engine"

/**
 * billing NEW-r2 —— persistLLMCalls 落**纯事实行**（workflow 路径经共用落账 helper），
 * 费用一律查询时经 llm_calls_costed 视图派生，且与手算一致（测试自建兜底价）。
 * 手算：量 in=1000/out=500/cr=200/cc=100 ——
 *   USD {3,15,3.75,0.3}: 3000+7500+375+60 = 10935 → 0.010935；
 *   CNY {21,105,26,2}:   76500 → 0.0765；÷7 = 0.010928571428571428。
 * EngineCallbacks：llm_calls_persist 已退役 —— 落账不再是 flag 可关的，行必落。
 */
let db: Database.Database
let dao: TokenUsageDAO
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
  svc = new ObservabilityService(new ExecutionDAO(db), dao)
  svc.bufferEvent("e1-n1", { type: "heartbeat", data: {} } as unknown as AgentEvent, META as never)
})

afterEach(() => {
  db.close()
})

function persistedRow(model: string, over: Partial<LLMCallRecord> = {}) {
  svc.persistLLMCalls("e1-n1", "e1", [record({ model, ...over })], "inst-1")
  const row = db.prepare("SELECT * FROM llm_calls WHERE model = ?").get(model) as Record<string, unknown> | undefined
  if (!row) throw new Error(`llm_calls 行未落库: model=${model}`)
  return row
}

function viewRow(id: string) {
  return db.prepare("SELECT cost_usd, vendor FROM llm_calls_costed WHERE id = ?").get(id) as { cost_usd: number | null; vendor: string | null }
}

function price(modelId: string, p: [number, number, number, number], currency: "USD" | "CNY") {
  new BillingDAO(db).createPrice({
    id: `OC-${modelId}`, vendor: "e2e", model_id: modelId,
    input_unit_price: p[0], output_unit_price: p[1], cache_write_unit_price: p[2], cache_read_unit_price: p[3],
    currency,
  })
}

describe("persistLLMCalls —— 落纯事实行", () => {
  it("行无 cost 列、source_path='workflow'、归属/instance 如实", () => {
    const r = persistedRow("E2E_TEST_obs-facts")
    expect(r).toMatchObject({
      source_path: "workflow",
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
      workflow_ref: "t.yaml", execution_id: "e1", node_execution_id: "e1-n1", instance_id: "inst-1",
      turn_index: 1, stop_reason: null,
    })
    for (const col of ["cost_usd", "cost_native", "cost_currency", "price_status"]) {
      expect(r).not.toHaveProperty(col)
    }
  })

  it("模型名带 [1M] 残渣 → 落库即规范名（视图匹配的前提）", () => {
    const r = persistedRow("qwen3.8-flash", { model: "qwen3.8-flash[1M]" })
    expect(r.model).toBe("qwen3.8-flash")
  })
})

describe("费用经视图派生，与手算一致（兜底价全时段回算）", () => {
  it("USD {3,15,3.75,0.3} → 视图 cost 0.010935、vendor 命中", () => {
    price("E2E_TEST_obs-usd", [3, 15, 3.75, 0.3], "USD")
    const r = persistedRow("E2E_TEST_obs-usd")
    expect(viewRow(String(r.id)).cost_usd).toBeCloseTo(0.010935, 12)
    expect(viewRow(String(r.id)).vendor).toBe("e2e")
  })

  it("CNY {21,105,26,2}（默认汇率 7.0）→ USD 基准 0.0765/7", () => {
    price("E2E_TEST_obs-cny", [21, 105, 26, 2], "CNY")
    const r = persistedRow("E2E_TEST_obs-cny")
    expect(viewRow(String(r.id)).cost_usd).toBeCloseTo(0.010928571428571428, 12)
  })

  it("未配价 → 视图 cost NULL（unpriced 不焊 0）；SDK 上报 costUsd 不影响任何口径（KD2）", () => {
    const priced = persistedRow("E2E_TEST_obs-sdk", { costUsd: 999.99 })
    expect(viewRow(String(priced.id)).cost_usd).toBeNull() // 只有价表能造出钱
    price("E2E_TEST_obs-sdk", [3, 15, 3.75, 0.3], "USD")
    expect(viewRow(String(priced.id)).cost_usd).toBeCloseTo(0.010935, 12) // 出钱 = 公式值，非 999.99
  })
})

describe("llm_calls_persist 已退役 —— 行必落", () => {
  it("EngineCallbacks 源码不再以 getFlag(llm_calls_persist) 门控落账", () => {
    const src = fs.readFileSync(path.join(__dirname, "../services/execution/EngineCallbacks.ts"), "utf-8")
    expect(src).not.toMatch(/getFlag\(\s*["']llm_calls_persist/)
  })

  it("feature flags 无 llm_calls_persist 键（旧键退役，配置残留按未知键忽略）", () => {
    expect(loadFeatureFlags()).not.toHaveProperty("llm_calls_persist")
  })

  it("无 flag 可关的现实下 persistLLMCalls 必落行（批量 compose+insert 语义保留）", () => {
    svc.persistLLMCalls("e1-n1", "e1", [
      record({ model: "m-a", turnIndex: 1 }),
      record({ model: "m-b", turnIndex: 2 }),
    ], "inst-9")
    const rows = db.prepare("SELECT model, turn_index, call_index, source_path FROM llm_calls ORDER BY turn_index").all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows.map(r => [r.model, r.turn_index, r.call_index, r.source_path])).toEqual([
      ["m-a", 1, 0, "workflow"],
      ["m-b", 2, 1, "workflow"],
    ])
  })
})
