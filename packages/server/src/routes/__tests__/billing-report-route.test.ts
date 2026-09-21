// billing-report-3 票01 · 报表 API 集成测试（summary + trend 端点）
// Seam: GET /api/system/billing/report/summary?from&to 与 /report/trend?from&to。
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
import type { LlmCallRow } from "../../db/types"
import type { LlmCallSourcePath } from "@octopus/shared"

const system = createSystemRoutes()
const app = new Hono().route("/api/system", system)

const SUMMARY = "/api/system/billing/report/summary"
const TREND = "/api/system/billing/report/trend"
const MODEL = "E2E_TEST_R3RT_M"

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

function row(id: string, over: Partial<LlmCallRow> & { cost: number | null; ts: number }): LlmCallRow {
  const { cost, ts, ...rest } = over
  return {
    id, node_execution_id: "rt-n1", execution_id: "rt-e1", turn_index: 1, call_index: 0,
    message_id: null, model: MODEL, stop_reason: null, timestamp: ts, duration_ms: 100, ttft_ms: null,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: cost, cost_native: cost, cost_currency: cost === null ? null : "USD",
    price_status: cost === null ? "unpriced" : "priced",
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
  const tu = new TokenUsageDAO(db)
  tu.insertLlmCall(row("c1", { cost: 0.4, ts: at(0, 12), input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 100, cache_read_tokens: 200 }))
  tu.insertLlmCall(row("c2", { cost: 0.1, ts: at(0, 0, 0, 30), input_tokens: 10, output_tokens: 20 }))
  tu.insertLlmCall(row("c3", { cost: 0.2, ts: at(0, 23, 59, 30, 999), input_tokens: 30, output_tokens: 40, cache_creation_tokens: 50, cache_read_tokens: 60, source_path: "interaction" }))
  tu.insertLlmCall(row("c4", { cost: null, ts: at(0, 13), input_tokens: 700, output_tokens: 300, cache_creation_tokens: 10, cache_read_tokens: 20 }))
  tu.insertLlmCall(row("b1", { cost: 7, ts: at(-1, 9) }))
  tu.insertLlmCall(row("b2", { cost: 3, ts: at(-1, 10), input_tokens: 5, output_tokens: 5, cache_creation_tokens: 5, cache_read_tokens: 5 }))
  tu.insertLlmCall(row("b3", { cost: null, ts: at(-1, 11), price_status: null, cost_currency: null, input_tokens: 1, output_tokens: 1, cache_creation_tokens: 1, cache_read_tokens: 1 }))
  tu.insertLlmCall(row("a1", { cost: 1, ts: at(-2, 12), input_tokens: 2, output_tokens: 3, cache_creation_tokens: 4, cache_read_tokens: 5 }))
  tu.insertLlmCall(row("o1", { cost: 999, ts: at(-40, 12), input_tokens: 111 })) // 默认 30 天窗口外
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE model = ?").run(MODEL)
  expect((getDb().prepare("SELECT COUNT(*) n FROM llm_calls WHERE model = ?").get(MODEL) as { n: number }).n).toBe(0)
  closeDb()
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f)
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
  it("手算值逐字段一致（AC1）：calls 8 / unpriced 2 ratio 1/4 / cost 11.7 / token 四类分列", async () => {
    const { status, body } = await get(SUMMARY + RANGE)
    expect(status).toBe(200)
    const b = body as unknown as SummaryBody
    expect(b.from).toBe(dateStr(-2))
    expect(b.to).toBe(dateStr(0))
    expect(b.total_calls).toBe(8)
    expect(b.unpriced.calls).toBe(2)
    expect(b.unpriced.ratio).toBeCloseTo(2 / 8, 10)
    expect(b.total_cost_usd).toBeCloseTo(11.7, 10)
    expect(b.tokens).toEqual({ in: 1748, out: 869, cache_w: 170, cache_r: 291 })
    // 默认设置 CNY @7.0（KD7/KD8）
    expect(b.display_currency).toBe("CNY")
    expect(b.currency_rate).toBe(7)
    expect(b.total_cost_display).toBeCloseTo(11.7 * 7, 10)
  })

  it("同条件 SQL 直查逐字段交叉（US5 抽查协议）", async () => {
    const { body } = await get(SUMMARY + RANGE)
    const b = body as unknown as SummaryBody
    const sql = getDb().prepare(`
      SELECT COUNT(*) calls,
             SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) priced,
             COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout,
             COALESCE(SUM(cache_creation_tokens),0) tcw, COALESCE(SUM(cache_read_tokens),0) tcr,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) cost
      FROM llm_calls WHERE timestamp >= ? AND timestamp <= ?
    `).get(at(-2, 0, 0, 0, 0), at(0, 23, 59, 59, 999)) as {
      calls: number; priced: number | null; tin: number; tout: number; tcw: number; tcr: number; cost: number | null
    }
    expect(b.total_calls).toBe(sql.calls)
    expect(b.total_cost_usd).toBeCloseTo(sql.cost as number, 6) // 容差 1e-6
    expect(b.tokens.in).toBe(sql.tin)
    expect(b.tokens.out).toBe(sql.tout)
    expect(b.tokens.cache_w).toBe(sql.tcw)
    expect(b.tokens.cache_r).toBe(sql.tcr)
    expect(b.unpriced.calls).toBe(sql.calls - (sql.priced as number))
    expect(b.unpriced.ratio).toBeCloseTo((sql.calls - (sql.priced as number)) / sql.calls, 10)
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
    expect(b.total_calls).toBe(8) // 8 + o1? 不 —— o1 在 -40d，仍在窗口外
    expect(b.total_cost_usd).toBeCloseTo(11.7, 10)
  })

  it("to < from → 400；非法日期格式/不存在的日期 → 400", async () => {
    expect((await get(SUMMARY + `?from=${dateStr(0)}&to=${dateStr(-2)}`)).status).toBe(400)
    expect((await get(SUMMARY + "?from=2026/01/01")).status).toBe(400)
    expect((await get(SUMMARY + "?from=2026-02-30&to=2026-03-01")).status).toBe(400)
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
    // A=1.0/1 行；B=10.0/3 行(含 legacy 计行)；C=0.7/4 行（边界 00:00:30、23:59:30.999 归 C，KD24）
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

  it("与 SQL 本地化分桶直查交叉（US5）", async () => {
    const { body } = await get(TREND + RANGE)
    const days = body.days as TrendDay[]
    const sql = getDb().prepare(`
      SELECT date(timestamp / 1000.0, 'unixepoch', 'localtime') d, COUNT(*) c,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) cost
      FROM llm_calls WHERE timestamp >= ? AND timestamp <= ? GROUP BY d ORDER BY d ASC
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
    expect(days.every(d => d.calls === 0 && d.cost_usd === 0 && d.cost_display === 0)).toBe(true)
    expect((await get(TREND + `?from=${dateStr(0)}&to=${dateStr(-2)}`)).status).toBe(400)
  })
})
