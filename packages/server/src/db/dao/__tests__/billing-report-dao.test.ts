// billing-report-3 票01 (billing NEW-r2 改版) · 报表聚合 DAO 单测（summary + trend）
// Seam: BillingDAO.reportSummary / reportTrend —— SQL 内 GROUP BY（KD22）、
// 本地日界（KD24）、费用 = 查询时按价行派生（钱不落账本）、
// 数量含 unpriced（KD21）、KD4：聚合不焊 0（有行无价 → cost NULL；空区间 → 0 结构）。
// seed = llm_calls 纯事实行 + billing_price_config 兜底价；期望值 = 价行手算（独立真相源）。
// 数据 E2E_TEST_R3_ 前缀随临时库销毁。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../schema"
import { BillingDAO } from "../billing-dao"
import { TokenUsageDAO } from "../token-usage-dao"
import type { LlmCallRow } from "../../types"
import type { LlmCallSourcePath } from "@octopus/shared"

let db: Database.Database
let dbPath: string
let dao: BillingDAO

/** 本地日历日（KD24 与服务端分桶同基准）。 */
const now = new Date()
function at(dayOffset: number, h = 12, mi = 0, s = 0, ms = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, mi, s, ms).getTime()
}
function dateStr(offset: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 价行匹配后的费用全部线性于 input_tokens：
//   M  = USD 兜底价 input 1000 / 1M（其余 0）→ cost_usd = in / 1000
//   MUP = 不配价 → 恒 unpriced（KD4「有行无价」现场）
//   CNY = CNY 兜底价 input 14000 / 1M → in 1000 = native 14 CNY = 2 USD @7.0
/** 纯事实行（NEW-r2：llm_calls 无 cost 列，钱查询时派生）。 */
function row(id: string, ts: number, over: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    id, node_execution_id: "r3-n1", execution_id: "r3-e1", turn_index: 1, call_index: 0,
    message_id: null, model: "E2E_TEST_R3_M", stop_reason: null, timestamp: ts, duration_ms: 100, ttft_ms: null,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    org: "default", workspace_id: "ws-r3", workflow_ref: "wf.yaml", node_id: "n1", session_id: "s-r3", instance_id: "i-r3",
    source_path: "workflow" as LlmCallSourcePath,
    ...over,
  }
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-report-dao-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new BillingDAO(db)
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-r3','R3','/tmp/r3','default',?,?)").run(t, t)
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('r3-e1','ws-r3','0','wf.yaml','R3','completed',?,?,?,?,?)`).run(t, t, "default", t, t)
  db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('r3-n1','r3-e1','n1','agent','completed',0,1,?,?)").run(t, t)

  // 兜底价（晚配价语义：落表即回算全部历史）
  dao.createPrice({ id: "p-r3-m", vendor: "E2E_TEST_R3V", model_id: "E2E_TEST_R3_M", input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD" })
  dao.createPrice({ id: "p-r3-cny", vendor: "E2E_TEST_R3V", model_id: "E2E_TEST_R3_CNY", input_unit_price: 14000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "CNY" })

  const tu = new TokenUsageDAO(db)
  // 三天窗口 D-2=A / D-1=B / D0=C：手算值见各断言
  tu.insertLlmCall(row("c1", at(0, 12), { input_tokens: 400, output_tokens: 500, cache_creation_tokens: 100, cache_read_tokens: 200 }))  // 0.4
  tu.insertLlmCall(row("c2", at(0, 0, 0, 30), { input_tokens: 100, output_tokens: 20 }))                                                // 0.1
  tu.insertLlmCall(row("c3", at(0, 23, 59, 30, 999), { input_tokens: 200, output_tokens: 40, cache_creation_tokens: 50, cache_read_tokens: 60, source_path: "interaction" })) // 0.2
  tu.insertLlmCall(row("c4", at(0, 13), { model: "E2E_TEST_R3_MUP", input_tokens: 700, output_tokens: 300, cache_creation_tokens: 10, cache_read_tokens: 20 })) // 有行无价
  tu.insertLlmCall(row("b1", at(-1, 9), { input_tokens: 7000 }))  // 尖峰日 B = 10× A
  tu.insertLlmCall(row("b2", at(-1, 10), { input_tokens: 3000, output_tokens: 5, cache_creation_tokens: 5, cache_read_tokens: 5 }))
  tu.insertLlmCall(row("b3", at(-1, 11), { model: "E2E_TEST_R3_MUP", input_tokens: 1, output_tokens: 1, cache_creation_tokens: 1, cache_read_tokens: 1 })) // unpriced：计行不计费
  tu.insertLlmCall(row("a1", at(-2, 12), { input_tokens: 1000, output_tokens: 3, cache_creation_tokens: 4, cache_read_tokens: 5 }))  // 1
  tu.insertLlmCall(row("cn1", at(-5, 12), { model: "E2E_TEST_R3_CNY", input_tokens: 1000 })) // CNY 价行：native 14 / 7 = 2 USD
  tu.insertLlmCall(row("o1", at(-40, 12), { input_tokens: 999000 })) // 窗口外（999）
})

afterEach(() => {
  db.close()
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

const A_START = at(-2, 0, 0, 0, 0)
const C_END = at(0, 23, 59, 59, 999)

describe("reportSummary", () => {
  it("手算值逐字段一致：费用=SUM(派生 cost_usd) 排除有行无价；数量含全部行；token 四类分列", () => {
    const s = dao.reportSummary(A_START, C_END)
    // calls: a1,b1,b2,b3,c1..c4 = 8；priced = 6；unpriced（c4/b3 无价）= 2
    expect(s.total_calls).toBe(8)
    expect(s.priced_calls).toBe(6)
    expect(s.unpriced_calls).toBe(2)
    // cost: 1 + 7 + 3 + 0.4 + 0.1 + 0.2 = 11.7
    expect(s.total_cost_usd).not.toBeNull()
    expect(s.total_cost_usd!).toBeCloseTo(11.7, 10)
    expect(s.input_tokens).toBe(400 + 100 + 200 + 700 + 7000 + 3000 + 1 + 1000)
    expect(s.output_tokens).toBe(500 + 20 + 40 + 300 + 0 + 5 + 1 + 3)
    expect(s.cache_creation_tokens).toBe(100 + 0 + 50 + 10 + 0 + 5 + 1 + 4)
    expect(s.cache_read_tokens).toBe(200 + 0 + 60 + 20 + 0 + 5 + 1 + 5)
  })

  it("窗口外行不计入（o1 在 -40d、cn1 在 -5d）", () => {
    const s = dao.reportSummary(A_START, C_END)
    expect(s.total_calls).toBe(8)
    expect(s.total_cost_usd!).toBeLessThan(100) // 无 o1 的 999、无 cn1 的 2
    expect(s.input_tokens).toBe(12401) // 手算 400+100+200+700+7000+3000+1+1000
  })

  it("与派生视图 SQL 直查交叉（独立真相源）", () => {
    const s = dao.reportSummary(A_START, C_END)
    const sql = db.prepare(`
      SELECT COUNT(*) AS total_calls,
             COUNT(cost_usd) AS priced_calls,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             SUM(cost_usd) AS total_cost_usd
      FROM llm_calls_costed WHERE timestamp >= ? AND timestamp <= ?
    `).get(A_START, C_END) as Record<string, number | null>
    expect({
      total_calls: s.total_calls, priced_calls: s.priced_calls,
      input_tokens: s.input_tokens, output_tokens: s.output_tokens,
      cache_creation_tokens: s.cache_creation_tokens, cache_read_tokens: s.cache_read_tokens,
    }).toEqual({
      total_calls: sql.total_calls, priced_calls: sql.priced_calls,
      input_tokens: sql.input_tokens, output_tokens: sql.output_tokens,
      cache_creation_tokens: sql.cache_creation_tokens, cache_read_tokens: sql.cache_read_tokens,
    })
    expect(s.unpriced_calls).toBe((sql.total_calls as number) - (sql.priced_calls as number))
    expect(s.total_cost_usd!).toBeCloseTo(sql.total_cost_usd as number, 10)
  })

  it("空区间 → 全 0 结构（AC2），非 NULL 非 404 语义", () => {
    const s = dao.reportSummary(at(-100, 0), at(-100, 23, 59, 59, 999))
    expect(s).toEqual({
      total_cost_usd: 0, total_calls: 0, priced_calls: 0, unpriced_calls: 0,
      input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
    })
  })

  it("有行但全无价 → cost NULL（KD4 不焊 0，NEW-r2 由「有行无价」造）", () => {
    const s = dao.reportSummary(at(0, 12, 30), at(0, 13, 30)) // 只罩住 c4（无价行）
    expect(s.total_calls).toBe(1)
    expect(s.unpriced_calls).toBe(1)
    expect(s.total_cost_usd).toBeNull()
    expect(s.input_tokens).toBe(700)
  })

  it("CNY 价行 ÷ 当前 usd_to_cny 折 USD；改汇率立即重算（规则账语义）", () => {
    const day5 = dao.reportSummary(at(-5, 0), at(-5, 23, 59, 59, 999))
    expect(day5.total_cost_usd!).toBeCloseTo(2, 10) // 14 CNY / 7.0
    dao.setSetting("usd_to_cny", "8")
    const r2 = dao.reportSummary(at(-5, 0), at(-5, 23, 59, 59, 999))
    expect(r2.total_cost_usd!).toBeCloseTo(14 / 8, 10) // 改汇率 → 历史全重算
    expect(r2.total_calls).toBe(1)
  })

  it("改价 → 历史立即重算：单价翻倍则费用翻倍，还原则回到原值", () => {
    const before = dao.reportSummary(A_START, C_END).total_cost_usd!
    dao.updatePrice("p-r3-m", { input_unit_price: 2000 })
    const doubled = dao.reportSummary(A_START, C_END)
    expect(doubled.total_cost_usd!).toBeCloseTo(before * 2, 10) // 23.4
    expect(doubled.total_calls).toBe(8)  // 行本身一字未动
    expect(doubled.unpriced_calls).toBe(2)
    dao.updatePrice("p-r3-m", { input_unit_price: 1000 })
    expect(dao.reportSummary(A_START, C_END).total_cost_usd!).toBeCloseTo(11.7, 10)
    // 删价 → 立即回到 NULL
    dao.deletePrice("p-r3-m")
    const gone = dao.reportSummary(A_START, C_END)
    expect(gone.total_cost_usd).toBeNull()
    expect(gone.total_calls).toBe(8)
    expect(gone.unpriced_calls).toBe(8)
  })
})

describe("reportTrend", () => {
  it("逐日聚合与手算一致；本地日界含 00:00:30 / 23:59:59.999 边界行（KD24）", () => {
    const t = dao.reportTrend(A_START, C_END)
    // date(timestamp/1000.0,'unixepoch','localtime') 本地分桶
    expect(t.map(d => d.day)).toEqual([dateStr(-2), dateStr(-1), dateStr(0)])
    // A: 1 行 1.0；B: 3 行(含无价行) 10.0（尖峰 = 10× A，AC3 可辨识）；C: 4 行 0.7
    expect(t[0]).toEqual({ day: dateStr(-2), calls: 1, priced_calls: 1, cost_usd: 1 })
    expect(t[1].calls).toBe(3)
    expect(t[1].priced_calls).toBe(2)
    expect(t[1].cost_usd).toBeCloseTo(10, 10)
    expect(t[2].calls).toBe(4)
    expect(t[2].cost_usd).toBeCloseTo(0.7, 10)
  })

  it("与派生视图 SQL 本地化分桶直查交叉", () => {
    const t = dao.reportTrend(A_START, C_END)
    const sql = db.prepare(`
      SELECT date(timestamp / 1000.0, 'unixepoch', 'localtime') AS day, COUNT(*) AS calls,
             COUNT(cost_usd) AS priced_calls,
             SUM(cost_usd) AS cost_usd
      FROM llm_calls_costed WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY day ORDER BY day ASC
    `).all(A_START, C_END) as Array<{ day: string; calls: number; priced_calls: number; cost_usd: number | null }>
    expect(t.map(x => ({ day: x.day, calls: x.calls, priced_calls: x.priced_calls }))).toEqual(
      sql.map(x => ({ day: x.day, calls: x.calls, priced_calls: x.priced_calls })),
    )
    t.forEach((x, i) => {
      if (sql[i].cost_usd === null) expect(x.cost_usd).toBeNull()
      else expect(x.cost_usd!).toBeCloseTo(sql[i].cost_usd as number, 10)
    })
  })

  it("全无价日：calls>0、cost NULL（不焊 0）", () => {
    const t = dao.reportTrend(at(0, 12, 30), at(0, 13, 30))
    expect(t).toEqual([{ day: dateStr(0), calls: 1, priced_calls: 0, cost_usd: null }])
  })

  it("尖峰日在趋势中为最大值且 ≥10× 相邻日（AC3 fixture 验证数据可辨识）", () => {
    const t = dao.reportTrend(A_START, C_END)
    const spike = t.reduce((m, d) => ((d.cost_usd ?? -1) > (m.cost_usd ?? -1) ? d : m), t[0])
    expect(spike.day).toBe(dateStr(-1))
    const other = t.find(d => d.day === dateStr(-2))!
    expect(spike.cost_usd!).toBeGreaterThanOrEqual(other.cost_usd! * 10)
  })

  it("同一模型两段时间价：逐日按命中分段计费", () => {
    // WIN 模型：[D-8, D-7) 价 1000、[D-7, D-6) 价 4000（epoch 直接用本地零点）
    dao.createPrice({ id: "p-w1", vendor: "E2E_TEST_R3V", model_id: "E2E_TEST_R3_WIN", input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD", valid_from: at(-8), valid_to: at(-7) })
    dao.createPrice({ id: "p-w2", vendor: "E2E_TEST_R3V", model_id: "E2E_TEST_R3_WIN", input_unit_price: 4000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD", valid_from: at(-7), valid_to: at(-6) })
    const tu = new TokenUsageDAO(db)
    tu.insertLlmCall(row("w1", at(-8, 12), { model: "E2E_TEST_R3_WIN", input_tokens: 1000 })) // → 1
    tu.insertLlmCall(row("w2", at(-7, 12), { model: "E2E_TEST_R3_WIN", input_tokens: 1000 })) // → 4
    const t = dao.reportTrend(at(-8, 0), at(-7, 23, 59, 59, 999))
    expect(t.map(d => ({ day: d.day, cost_usd: d.cost_usd }))).toEqual([
      { day: dateStr(-8), cost_usd: expect.closeTo(1, 10) },
      { day: dateStr(-7), cost_usd: expect.closeTo(4, 10) },
    ])
    // 窗口外无兜底 → 立即 unpriced（w3 在 D-6）
    tu.insertLlmCall(row("w3", at(-6, 12), { model: "E2E_TEST_R3_WIN", input_tokens: 1000 }))
    expect(dao.reportTrend(at(-6, 0), at(-6, 23, 59, 59, 999))).toEqual([{ day: dateStr(-6), calls: 1, priced_calls: 0, cost_usd: null }])
    // 补兜底价 → 历史窗口外区间立即出钱
    dao.createPrice({ id: "p-wc", vendor: "E2E_TEST_R3V", model_id: "E2E_TEST_R3_WIN", input_unit_price: 500, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD" })
    expect(dao.reportTrend(at(-6, 0), at(-6, 23, 59, 59, 999))[0].cost_usd).toBeCloseTo(0.5, 10)
    // 窗口价仍优先于兜底：D-8/D-7 不回落
    const again = dao.reportTrend(at(-8, 0), at(-7, 23, 59, 59, 999))
    expect(again[0].cost_usd).toBeCloseTo(1, 10)
    expect(again[1].cost_usd).toBeCloseTo(4, 10)
  })
})
