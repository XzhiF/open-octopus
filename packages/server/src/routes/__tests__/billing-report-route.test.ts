// billing-report-3 票01 · 报表 API 集成测试（summary + trend 端点，billing NEW-r2 改版）
// Seam: GET /api/system/billing/report/summary?from&to 与 /report/trend?from&to。
// NEW-r2：账本只存事实行，报表费用 = 查询时按价行派生（配价即回算全部历史，
// 删价即回落 NULL）；unpriced 由「无价行/窗口未命中」构造，NULL 不焊 0（KD4）。
// 出参逐字段与 SQL 直查/手算交叉（期望值非 API 自推，Anti-Fake-Run）；
// 展示币种换算 = 同一全局汇率（US6）；空区间全 0 结构（AC2）；非法区间 400；
// 默认区间 = 最近 30 天含今日。数据 E2E_TEST_R3RT_ 前缀，尾部清理。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Hono } from "hono"
import { initDb, closeDb, getDb } from "../../db/connection"
import { createSystemRoutes } from "../system"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { BillingDAO } from "../../db/dao/billing-dao"
import type { LlmCallRow } from "../../db/types"
import type { LlmCallSourcePath } from "@octopus/shared"

const system = createSystemRoutes()
const app = new Hono().route("/api/system", system)

const SUMMARY = "/api/system/billing/report/summary"
const TREND = "/api/system/billing/report/trend"
const MODEL = "E2E_TEST_R3RT_M"       // 兜底价 USD Pi=1000 → cost = input/1000
const MUP = "E2E_TEST_R3RT_MUP"       // 故意不配价 → 派生 NULL

let dbPath: string

const now = new Date()
function at(dayOffset: number, h = 12, mi = 0, s = 0, ms = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, mi, s, ms).getTime()
}
function dateStr(offset: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function row(id: string, over: Partial<LlmCallRow> & { model?: string; ts: number }): LlmCallRow {
  const { ts, ...rest } = over
  return {
    id, node_execution_id: "rt-n1", execution_id: "rt-e1", turn_index: 1, call_index: 0,
    message_id: null, model: MODEL, stop_reason: null, timestamp: ts, duration_ms: 100, ttft_ms: null,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    org: "default", workspace_id: "ws-rt", workflow_ref: "wf.yaml", node_id: "n1", session_id: "s-rt", instance_id: "i-rt",
    source_path: "workflow" as LlmCallSourcePath,
    ...rest,
  }
}

const RANGE = `?from=${dateStr(-2)}&to=${dateStr(0)}`

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-report-${process.pid}-${Date.now()}.db`)
  initDb(dbPath)
  const db = getDb()
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-rt','RT','/tmp/rt','default',?,?)").run(t, t)
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('rt-e1','ws-rt','0','wf.yaml','RT','completed',?,?,?,?,?)`).run(t, t, "default", t, t)
  db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('rt-n1','rt-e1','n1','agent','completed',0,1,?,?)").run(t, t)

  // M 兜底价：input 1000/1M、其余 0 → 派生 cost_usd = input_tokens/1000（期望数字由 token 反推，与旧快照口径同值）
  new BillingDAO(db).createPrice({ id: "p-rt-m", vendor: "E2E_TEST_VRT", model_id: MODEL, input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD" })

  const tu = new TokenUsageDAO(db)
  tu.insertLlmCall(row("c1", { ts: at(0, 12), input_tokens: 400, output_tokens: 500, cache_creation_tokens: 100, cache_read_tokens: 200 }))   // 0.4
  tu.insertLlmCall(row("c2", { ts: at(0, 0, 0, 30), input_tokens: 100, output_tokens: 20 }))                                                   // 0.1（KD24 下界内）
  tu.insertLlmCall(row("c3", { ts: at(0, 23, 59, 30, 999), input_tokens: 200, output_tokens: 40, cache_creation_tokens: 50, cache_read_tokens: 60, source_path: "interaction" })) // 0.2
  tu.insertLlmCall(row("c4", { ts: at(0, 13), model: MUP, input_tokens: 700, output_tokens: 300, cache_creation_tokens: 10, cache_read_tokens: 20 })) // unpriced
  tu.insertLlmCall(row("b1", { ts: at(-1, 9), input_tokens: 7000 }))                                                                            // 7
  tu.insertLlmCall(row("b2", { ts: at(-1, 10), input_tokens: 3000, output_tokens: 5, cache_creation_tokens: 5, cache_read_tokens: 5 }))         // 3
  tu.insertLlmCall(row("b3", { ts: at(-1, 11), model: MUP, input_tokens: 1, output_tokens: 1, cache_creation_tokens: 1, cache_read_tokens: 1 })) // unpriced
  tu.insertLlmCall(row("a1", { ts: at(-2, 12), input_tokens: 1000, output_tokens: 3, cache_creation_tokens: 4, cache_read_tokens: 5 }))         // 1
  tu.insertLlmCall(row("o1", { ts: at(-40, 12), input_tokens: 999000 }))                                                                        // 999；默认 30 天窗口外
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE model LIKE 'E2E_TEST_R3RT%'").run()
  getDb().prepare("DELETE FROM billing_price_config WHERE model_id LIKE 'E2E_TEST_%'").run()
  getDb().prepare("DELETE FROM billing_setting").run()
  expect((getDb().prepare("SELECT COUNT(*) n FROM llm_calls WHERE model LIKE 'E2E_TEST_R3RT%'").get() as { n: number }).n).toBe(0)
  closeDb()
  for (const f of [dbPath + "-shm", dbPath + "-wal", dbPath]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

async function get(url: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(url)
  return { status: res.status, body: await res.json() }
}

interface SummaryBody {
  from: string; to: string
  total_cost_usd: number | null; total_cost_display: number | null
  total_calls: number
  tokens: { in: number; out: number; cache_w: number; cache_r: number }
  unpriced: { calls: number; ratio: number }
  currency_rate: number; display_currency: string
}

describe("GET /billing/report/summary", () => {
  it("手算值逐字段一致（AC1）：calls 8 / unpriced 2 ratio 1/4 / cost 11.7 / token 四类分列（钱 = 派生）", async () => {
    const { status, body } = await get(SUMMARY + RANGE)
    expect(status).toBe(200)
    const b = body as unknown as SummaryBody
    expect(b.from).toBe(dateStr(-2))
    expect(b.to).toBe(dateStr(0))
    expect(b.total_calls).toBe(8)
    expect(b.unpriced.calls).toBe(2)
    expect(b.unpriced.ratio).toBeCloseTo(2 / 8, 10)
    expect(b.total_cost_usd).toBeCloseTo(11.7, 10) // 0.4+0.1+0.2 + 7+3 + 1
    expect(b.tokens).toEqual({ in: 12401, out: 869, cache_w: 170, cache_r: 291 })
    // 默认设置 CNY @7.0（KD7/KD8）
    expect(b.display_currency).toBe("CNY")
    expect(b.currency_rate).toBe(7)
    expect(b.total_cost_display).toBeCloseTo(11.7 * 7, 10)
  })

  it("同条件 SQL 直查逐字段交叉（US5 抽查协议；派生钱走视图）", async () => {
    const { body } = await get(SUMMARY + RANGE)
    const b = body as unknown as SummaryBody
    const sql = getDb().prepare(`
      SELECT COUNT(*) calls,
             COUNT(cost_usd) priced,
             COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout,
             COALESCE(SUM(cache_creation_tokens),0) tcw, COALESCE(SUM(cache_read_tokens),0) tcr,
             SUM(cost_usd) cost
      FROM llm_calls_costed WHERE model LIKE 'E2E_TEST_R3RT%' AND timestamp >= ? AND timestamp <= ?
    `).get(at(-2, 0, 0, 0, 0), at(0, 23, 59, 59, 999)) as {
      calls: number; priced: number; tin: number; tout: number; tcw: number; tcr: number; cost: number | null
    }
    expect(b.total_calls).toBe(sql.calls)
    expect(b.total_cost_usd).toBeCloseTo(sql.cost as number, 6) // 容差 1e-6
    expect(b.tokens.in).toBe(sql.tin)
    expect(b.tokens.out).toBe(sql.tout)
    expect(b.tokens.cache_w).toBe(sql.tcw)
    expect(b.tokens.cache_r).toBe(sql.tcr)
    expect(b.unpriced.calls).toBe(sql.calls - sql.priced)
    expect(b.unpriced.ratio).toBeCloseTo((sql.calls - sql.priced) / sql.calls, 10)
  })

  it("空区间 → 全 0 结构 200（AC2），非 404", async () => {
    const { status, body } = await get(SUMMARY + `?from=${dateStr(-100)}&to=${dateStr(-98)}`)
    expect(status).toBe(200)
    const b = body as unknown as SummaryBody
    expect(b.total_cost_usd).toBe(0)
    expect(b.total_cost_display).toBe(0)
    expect(b.total_calls).toBe(0)
    expect(b.tokens).toEqual({ in: 0, out: 0, cache_w: 0, cache_r: 0 })
    expect(b.unpriced).toEqual({ calls: 0, ratio: 0 })
  })

  it("缺省参数 = 最近 30 天含今日：窗口罩住全部 fixture 但排除 -40d 行", async () => {
    const { status, body } = await get(SUMMARY)
    expect(status).toBe(200)
    const b = body as unknown as SummaryBody
    expect(b.to).toBe(dateStr(0))
    expect(b.from).toBe(dateStr(-29))
    expect(b.total_calls).toBe(8) // o1 在 -40d，仍在窗口外
    expect(b.total_cost_usd).toBeCloseTo(11.7, 10)
  })

  it("to < from → 400；非法日期格式/不存在的日期 → 400", async () => {
    expect((await get(SUMMARY + `?from=${dateStr(0)}&to=${dateStr(-2)}`)).status).toBe(400)
    expect((await get(SUMMARY + "?from=abc")).status).toBe(400)
    expect((await get(SUMMARY + "?from=2026-13-45")).status).toBe(400)
    expect((await get(SUMMARY + "?to=2026-02-30")).status).toBe(400)
  })

  it("展示币种换算与汇率设置联动（US6 同汇率）", async () => {
    // 改汇率 6.5 → display = usd * 6.5
    await app.request("/api/system/billing/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd_to_cny: 6.5 }),
    })
    let { body } = await get(SUMMARY + RANGE)
    let b = body as unknown as SummaryBody
    expect(b.currency_rate).toBe(6.5)
    expect(b.total_cost_display).toBeCloseTo(11.7 * 6.5, 10)
    // 切 USD → rate 恒 1，display ≡ usd
    await app.request("/api/system/billing/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_currency: "USD" }),
    })
    ;({ body } = await get(SUMMARY + RANGE))
    b = body as unknown as SummaryBody
    expect(b.display_currency).toBe("USD")
    expect(b.currency_rate).toBe(1)
    expect(b.total_cost_display).toBeCloseTo(b.total_cost_usd as number, 10)
    // 还原默认
    await app.request("/api/system/billing/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd_to_cny: 7, display_currency: "CNY" }),
    })
  })
})

interface TrendDay { date: string; cost_usd: number | null; cost_display: number | null; calls: number }

describe("GET /billing/report/trend", () => {
  it("逐日值 = 手算 + 本地化分桶直查；尖峰日可辨识（AC1/AC3）", async () => {
    const { status, body } = await get(TREND + RANGE)
    expect(status).toBe(200)
    const days = body.days as TrendDay[]
    expect(days.map(d => d.date)).toEqual([dateStr(-2), dateStr(-1), dateStr(0)])
    // A=1.0/1 行；B=10.0/3 行(含 unpriced 计行)；C=0.7/4 行（边界 00:00:30、23:59:30.999 归 C，KD24）
    expect(days[0].cost_usd).toBeCloseTo(1, 10)
    expect(days[0].calls).toBe(1)
    expect(days[1].cost_usd).toBeCloseTo(10, 10)
    expect(days[1].calls).toBe(3)
    expect(days[2].cost_usd).toBeCloseTo(0.7, 10)
    expect(days[2].calls).toBe(4)
    // 尖峰 = B 且 10× A
    expect(days[1].cost_usd).toBeGreaterThanOrEqual((days[0].cost_usd as number) * 10)
    // 展示换算：CNY@7
    expect(body.currency_rate).toBe(7)
    expect(days[2].cost_display).toBeCloseTo(0.7 * 7, 10)
  })

  it("无调用日补 0（区间含空日）", async () => {
    const { status, body } = await get(TREND + `?from=${dateStr(-3)}&to=${dateStr(0)}`)
    expect(status).toBe(200)
    const days = body.days as TrendDay[]
    expect(days).toHaveLength(4)
    expect(days[0]).toEqual({ date: dateStr(-3), cost_usd: 0, cost_display: 0, calls: 0 })
    expect(days.slice(1).map(d => d.calls)).toEqual([1, 3, 4])
  })

  it("与 SQL 本地化分桶直查交叉（US5；派生钱走视图）", async () => {
    const { body } = await get(TREND + RANGE)
    const days = body.days as TrendDay[]
    const sql = getDb().prepare(`
      SELECT date(timestamp / 1000.0, 'unixepoch', 'localtime') d, COUNT(*) c,
             SUM(cost_usd) cost
      FROM llm_calls_costed WHERE model LIKE 'E2E_TEST_R3RT%' AND timestamp >= ? AND timestamp <= ? GROUP BY d ORDER BY d ASC
    `).all(at(-2, 0, 0, 0, 0), at(0, 23, 59, 59, 999)) as Array<{ d: string; c: number; cost: number | null }>
    expect(days.map(x => x.date)).toEqual(sql.map(x => x.d))
    sql.forEach((x, i) => {
      expect(days[i].calls).toBe(x.c)
      if (x.cost === null) expect(days[i].cost_usd).toBeNull()
      else expect(days[i].cost_usd).toBeCloseTo(x.cost, 6)
    })
  })

  it("空区间 → 逐日全 0；to < from → 400", async () => {
    const { status, body } = await get(TREND + `?from=${dateStr(-100)}&to=${dateStr(-98)}`)
    expect(status).toBe(200)
    const days = body.days as TrendDay[]
    expect(days).toHaveLength(3)
    expect(days.every(d => d.cost_usd === 0 && d.cost_display === 0 && d.calls === 0)).toBe(true)
    expect((await get(TREND + `?from=${dateStr(0)}&to=${dateStr(-2)}`)).status).toBe(400)
  })
})

// NEW-r2 新增语义面：① 同模型两段时间价 → 逐日/汇总按窗口分段正确计费；
// ② 迟到兜底价 → 之前未定价区间立即回算出钱（窗口价仍优先）；删价回落 NULL。
describe("同模型多段窗口价 + 迟到兜底价（NEW-r2 回算语义）", () => {
  const WIN = "E2E_TEST_R3RT_WIN"
  const billing = () => new BillingDAO(getDb())

  beforeAll(() => {
    const tu = new TokenUsageDAO(getDb())
    tu.insertLlmCall(row("w1", { ts: at(-6, 12), model: WIN, input_tokens: 1000 }))
    tu.insertLlmCall(row("w2", { ts: at(-5, 12), model: WIN, input_tokens: 1000 }))
    tu.insertLlmCall(row("w3", { ts: at(-4, 12), model: WIN, input_tokens: 1000 }))
    tu.insertLlmCall(row("w4", { ts: at(-20, 12), model: WIN, input_tokens: 1000 }))
    // 两段时间价：[-7,-5) 单价 1000；[-5,-3) 单价 3000（半开区间无缝衔接）
    billing().createPrice({ id: "p-rt-w1", vendor: "E2E_TEST_VRT", model_id: WIN, input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD", valid_from: at(-7, 0, 0, 0, 0), valid_to: at(-5, 0, 0, 0, 0) })
    billing().createPrice({ id: "p-rt-w2", vendor: "E2E_TEST_VRT", model_id: WIN, input_unit_price: 3000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD", valid_from: at(-5, 0, 0, 0, 0), valid_to: at(-3, 0, 0, 0, 0) })
  })

  it("趋势逐日按窗口分段计费：d-6/d-5/d-4 = 1/3/3；汇总 7（3 行）", async () => {
    const { body } = await get(TREND + `?from=${dateStr(-6)}&to=${dateStr(-4)}`)
    const days = body.days as TrendDay[]
    expect(days.map(d => d.date)).toEqual([dateStr(-6), dateStr(-5), dateStr(-4)])
    expect(days.map(d => d.cost_usd)).toEqual([1, 3, 3])
    expect(days.map(d => d.calls)).toEqual([1, 1, 1])

    const { body: sum } = await get(SUMMARY + `?from=${dateStr(-6)}&to=${dateStr(-4)}`)
    const s = sum as unknown as SummaryBody
    expect(s.total_calls).toBe(3)
    expect(s.total_cost_usd).toBeCloseTo(7, 10)
    expect(s.unpriced.calls).toBe(0)
  })

  it("窗口外 w4（d-20）暂无价 → NULL 不焊 0；补兜底价后立即回算 0.5 且窗口价仍优先；删价回落", async () => {
    const before = await get(SUMMARY + `?from=${dateStr(-20)}&to=${dateStr(-20)}`)
    const b0 = before.body as unknown as SummaryBody
    expect(b0.total_calls).toBe(1)
    expect(b0.total_cost_usd).toBeNull() // 有行全未定价 = NULL（区别于无行 0）
    expect(b0.unpriced).toEqual({ calls: 1, ratio: 1 })

    const cat = billing().createPrice({ id: "p-rt-wc", vendor: "E2E_TEST_VRT", model_id: WIN, input_unit_price: 500, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD" })
    const after = await get(SUMMARY + `?from=${dateStr(-20)}&to=${dateStr(-20)}`)
    const b1 = after.body as unknown as SummaryBody
    expect(b1.total_cost_usd).toBeCloseTo(0.5, 10) // 迟到兜底价 = 立即给历史回算
    expect(b1.unpriced).toEqual({ calls: 0, ratio: 0 })
    // 窗口价优先级不变：d-6..d-4 仍是 1/3/3（兜底价 0.5 不得覆盖窗口）
    const { body: tb } = await get(TREND + `?from=${dateStr(-6)}&to=${dateStr(-4)}`)
    expect((tb.days as TrendDay[]).map(d => d.cost_usd)).toEqual([1, 3, 3])

    expect(billing().deletePrice(cat.id)).toBe(true)
    const reverted = await get(SUMMARY + `?from=${dateStr(-20)}&to=${dateStr(-20)}`)
    expect((reverted.body as unknown as SummaryBody).total_cost_usd).toBeNull()
  })

  it("给既有未定价模型（MUP）配兜底价 → 原区间汇总立即含其历史；删价复原", async () => {
    const p = billing().createPrice({ id: "p-rt-mup", vendor: "E2E_TEST_VRT", model_id: MUP, input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD" })
    const { body } = await get(SUMMARY + RANGE)
    const b = body as unknown as SummaryBody
    // c4(700)+b3(1) 由 NULL → 0.7+0.001；原 11.7 → 12.401
    expect(b.total_cost_usd).toBeCloseTo(12.401, 10)
    expect(b.unpriced).toEqual({ calls: 0, ratio: 0 })
    expect(billing().deletePrice(p.id)).toBe(true)
    const back = await get(SUMMARY + RANGE)
    expect((back.body as unknown as SummaryBody).total_cost_usd).toBeCloseTo(11.7, 10)
  })
})
