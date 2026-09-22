// 04 · 记账接线回归（billing NEW-r2 —— 快照账 → 规则账）
// Seam: TokenUsageDAO.recordNodeUsage / 共用落账 helper / llm_calls_costed 视图。
// 翻转语义：钱不落账本 —— ntu 是纯 token 账；llm_calls 行是纯事实；
// 一切费用查询时按 billing_price_config 窗口派生。存量/新建价行默认兜底价 →
// **配价立即回算全部历史**（与旧快照语义相反：先落的行配价后查询即出钱）。
// 手算期望：量 in=1000/out=500/cr=200/cc=100 ——
//   USD {3,15,3.75,0.3}: 3000+7500+375(cc×3.75)+60(cr×0.3) = 10935 → 0.010935；
//   CNY {21,105,26,2}:   21000+52500+2600+400 = 76500 → 0.0765；÷7 → 0.010928571428571428。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { recordLlmCall } from "../services/llm-call-ledger"

let db: Database.Database
let dao: TokenUsageDAO
let billing: BillingDAO

const now = () => new Date().toISOString()
const usage4 = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 }
const TS = 1700000000000

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

const colsOf = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)

function recordCall(id: string, model: string, ts = TS) {
  recordLlmCall({
    id, sourcePath: "workflow", nodeExecutionId: "ne-1", executionId: "e-1",
    turnIndex: 1, callIndex: 0, model, usage: usage4, timestamp: ts, durationMs: 100,
    org: "o", workspaceId: "ws-1", workflowRef: "t.yaml", nodeId: "n1",
  }, dao)
}

function viewCost(id: string): { cost_usd: number | null; vendor: string | null } {
  return db.prepare("SELECT cost_usd, vendor FROM llm_calls_costed WHERE id = ?").get(id) as { cost_usd: number | null; vendor: string | null }
}

describe("NEW-r2 表形状 —— 钱不落账本", () => {
  it("PRAGMA：llm_calls 无 cost_usd/cost_native/cost_currency/price_status；ntu 无 cost_usd", () => {
    for (const col of ["cost_usd", "cost_native", "cost_currency", "price_status"]) {
      expect(colsOf("llm_calls")).not.toContain(col)
    }
    expect(colsOf("node_token_usages")).not.toContain("cost_usd")
  })

  it("recordNodeUsage 只落 token（同 id UPSERT 也无钱可落）", () => {
    dao.recordNodeUsage({ id: "t1", nodeExecutionId: "ne-1", model: "m-x", usage: usage4, source: "node", createdAt: now() })
    const r = db.prepare("SELECT * FROM node_token_usages WHERE id='t1'").get() as Record<string, unknown>
    expect(Object.keys(r).sort()).toEqual([
      "cache_creation_tokens", "cache_read_tokens", "created_at", "id", "input_tokens",
      "model", "node_execution_id", "output_tokens", "source",
    ])
    expect(r).toMatchObject({ input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100 })
  })

  it("llm_calls 经落账 helper 写入后行形状 = 纯事实（封闭列集，防快照列回潮）", () => {
    recordCall("c-shape", "m-y")
    expect(Object.keys(db.prepare("SELECT * FROM llm_calls WHERE id='c-shape'").get() as object).sort()).toEqual([
      "cache_creation_tokens", "cache_read_tokens", "call_index", "duration_ms", "execution_id",
      "id", "input_tokens", "instance_id", "message_id", "model", "node_execution_id", "node_id",
      "org", "output_tokens", "session_id", "source_path", "stop_reason", "timestamp", "ttft_ms",
      "turn_index", "workflow_ref", "workspace_id",
    ])
  })
})

describe("AC1 · 记账写路径源码无 BillingService/computeForModel（写入时算价链路整体退役）", () => {
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
      expect(src).not.toMatch(/BillingService|computeForModel/)
    })
  }
})

describe("配价 → 查询派生费用一致（llm_calls_costed 视图，NEW-r2 翻转语义）", () => {
  it("先落行（无价）→ NULL；配兜底价 → 同一查询立即出钱（回算历史，不焊 0）", () => {
    recordCall("c-retro", "E2E_TEST_wired-usd")
    expect(viewCost("c-retro")).toEqual({ cost_usd: null, vendor: null }) // unpriced 态如实 NULL

    billing.createPrice({
      id: "W-retro", vendor: "e2e", model_id: "E2E_TEST_wired-usd",
      input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
      currency: "USD",
    })
    const r = viewCost("c-retro")
    expect(r.cost_usd).toBeCloseTo(0.010935, 12)
    expect(r.vendor).toBe("e2e")
    // price_status 派生口径：cost_usd 非 NULL → priced
    const st = db.prepare("SELECT CASE WHEN cost_usd IS NULL THEN 'unpriced' ELSE 'priced' END s FROM llm_calls_costed WHERE id='c-retro'").get() as { s: string }
    expect(st.s).toBe("priced")
  })

  it("CNY 兜底价 → USD 基准 = native ÷ 当前 usd_to_cny（默认 7.0）", () => {
    expect(billing.getUsdToCny()).toBe(7.0)
    billing.createPrice({
      id: "W-cny", vendor: "cn", model_id: "E2E_TEST_wired-cny",
      input_unit_price: 21, output_unit_price: 105, cache_write_unit_price: 26, cache_read_unit_price: 2,
      currency: "CNY",
    })
    recordCall("c-cny", "E2E_TEST_wired-cny")
    expect(viewCost("c-cny").cost_usd).toBeCloseTo(0.010928571428571428, 12) // 0.0765/7 手算
  })

  it("改汇率 → 全局折价重算（规则账语义）", () => {
    billing.createPrice({
      id: "W-rate", vendor: "cn", model_id: "E2E_TEST_rate",
      input_unit_price: 21, output_unit_price: 105, cache_write_unit_price: 26, cache_read_unit_price: 2,
      currency: "CNY",
    })
    recordCall("c-rate", "E2E_TEST_rate")
    expect(viewCost("c-rate").cost_usd).toBeCloseTo(0.0765 / 7, 12)
    billing.setSetting("usd_to_cny", "5.1")
    expect(viewCost("c-rate").cost_usd).toBeCloseTo(0.0765 / 5.1, 12)
  })

  it("时间段价命中窗口才出钱；窗口外回落到兜底价/NULL（半开区间 [from,to)）", () => {
    recordCall("c-win", "E2E_TEST_win", TS)
    billing.createPrice({
      id: "W-win", vendor: "e2e", model_id: "E2E_TEST_win",
      input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
      currency: "USD", valid_from: TS + 1, valid_to: TS + 1000,
    })
    expect(viewCost("c-win").cost_usd).toBeNull() // TS 落在 [TS+1, TS+1000) 之外
    billing.createPrice({
      id: "W-win2", vendor: "e2e", model_id: "E2E_TEST_win",
      input_unit_price: 6, output_unit_price: 30, cache_write_unit_price: 7.5, cache_read_unit_price: 0.6,
      currency: "USD", valid_from: TS, valid_to: TS + 1, // [TS, TS+1) 贴边不重叠，恰命中 TS
    })
    expect(viewCost("c-win").cost_usd).toBeCloseTo(0.02187, 12)
    expect(viewCost("c-win").vendor).toBe("e2e")
  })

  it("落账端归一 → 配价端也归一：价配 `x[1M]` 命中账上 `x`（Q9 双端同函数）", () => {
    recordCall("c-norm", "qwen3.8-flash[1M]")
    billing.createPrice({
      id: "W-norm", vendor: "qwen", model_id: "qwen3.8-flash[1M]",
      input_unit_price: 1, output_unit_price: 2, cache_write_unit_price: 0.5, cache_read_unit_price: 0.1,
      currency: "USD",
    })
    expect(viewCost("c-norm").cost_usd).toBeCloseTo((1000 + 1000 + 50 + 20) / 1e6, 12) // in×1+out×2+cc×0.5+cr×0.1
  })

  it("空账本 / 全无价账本：派生聚合 NULL 不焊 0", () => {
    recordCall("c-none", "E2E_TEST_nobody")
    const agg = db.prepare("SELECT SUM(cost_usd) s, COUNT(*) n, COUNT(cost_usd) p FROM llm_calls_costed WHERE id='c-none'").get() as { s: number | null; n: number; p: number }
    expect(agg).toEqual({ s: null, n: 1, p: 0 }) // complete = COUNT(*)=COUNT(cost) → false
  })
})
