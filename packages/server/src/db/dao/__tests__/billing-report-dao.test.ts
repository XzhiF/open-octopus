// billing-report-3 票01 · 报表聚合 DAO 单测（summary + trend）
// Seam: BillingDAO.reportSummary / reportTrend —— SQL 内 GROUP BY（KD22）、
// 本地日界（KD24）、费用排除 unpriced、数量含 unpriced（KD21）、
// KD4：聚合不焊 0（有行但全无 priced → cost NULL；空区间 → 0 结构）。
// 期望值全部手写在测试里（独立真相源，Anti-Fake-Run），数据 E2E_TEST_R3_ 前缀随临时库销毁。
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

function row(id: string, over: Partial<LlmCallRow> & { cost: number | null; ts: number }): LlmCallRow {
  const { cost, ts, ...rest } = over
  return {
    id, node_execution_id: "r3-n1", execution_id: "r3-e1", turn_index: 1, call_index: 0,
    message_id: null, model: "E2E_TEST_R3_M", stop_reason: null, timestamp: ts, duration_ms: 100, ttft_ms: null,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: cost, cost_native: cost, cost_currency: cost === null ? null : "USD",
    price_status: cost === null ? "unpriced" : "priced",
    org: "default", workspace_id: "ws-r3", workflow_ref: "wf.yaml", node_id: "n1", session_id: "s-r3", instance_id: "i-r3",
    source_path: "workflow" as LlmCallSourcePath,
    ...rest,
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

  const tu = new TokenUsageDAO(db)
  // 三天窗口 D-2=A / D-1=B / D0=C：手算值见各断言
  tu.insertLlmCall(row("c1", { cost: 0.4, ts: at(0, 12), input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 100, cache_read_tokens: 200 }))
  tu.insertLlmCall(row("c2", { cost: 0.1, ts: at(0, 0, 0, 30), input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 }))
  tu.insertLlmCall(row("c3", { cost: 0.2, ts: at(0, 23, 59, 30, 999), input_tokens: 30, output_tokens: 40, cache_creation_tokens: 50, cache_read_tokens: 60, source_path: "interaction" }))
  tu.insertLlmCall(row("c4", { cost: null, ts: at(0, 13), input_tokens: 700, output_tokens: 300, cache_creation_tokens: 10, cache_read_tokens: 20 }))
  tu.insertLlmCall(row("b1", { cost: 7, ts: at(-1, 9) })) // 尖峰日 B = 10× A
  tu.insertLlmCall(row("b2", { cost: 3, ts: at(-1, 10), input_tokens: 5, output_tokens: 5, cache_creation_tokens: 5, cache_read_tokens: 5 }))
  tu.insertLlmCall(row("b3", { cost: null, ts: at(-1, 11), price_status: null, cost_currency: null, input_tokens: 1, output_tokens: 1, cache_creation_tokens: 1, cache_read_tokens: 1 })) // legacy NULL 状态：计行不计费
  tu.insertLlmCall(row("a1", { cost: 1, ts: at(-2, 12), input_tokens: 2, output_tokens: 3, cache_creation_tokens: 4, cache_read_tokens: 5 }))
  tu.insertLlmCall(row("o1", { cost: 999, ts: at(-40, 12), input_tokens: 111 })) // 窗口外
})

afterEach(() => {
  db.close()
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

const A_START = at(-2, 0, 0, 0, 0)
const C_END = at(0, 23, 59, 59, 999)

describe("reportSummary", () => {
  it("手算值逐字段一致：费用=SUM(priced) 排除 unpriced/legacy；数量含全部行；token 四类分列", () => {
    const s = dao.reportSummary(A_START, C_END)
    // calls: a1,b1,b2,b3,c1..c4 = 8；priced = 6；unpriced(b3 NULL 亦计) = 2
    expect(s.total_calls).toBe(8)
    expect(s.priced_calls).toBe(6)
    expect(s.unpriced_calls).toBe(2)
    // cost: 1 + 7 + 3 + 0.4 + 0.1 + 0.2 = 11.7
    expect(s.total_cost_usd).not.toBeNull()
    expect(s.total_cost_usd!).toBeCloseTo(11.7, 10)
    expect(s.input_tokens).toBe(1000 + 10 + 30 + 700 + 0 + 5 + 1 + 2)
    expect(s.output_tokens).toBe(500 + 20 + 40 + 300 + 0 + 5 + 1 + 3)
    expect(s.cache_creation_tokens).toBe(100 + 0 + 50 + 10 + 0 + 5 + 1 + 4)
    expect(s.cache_read_tokens).toBe(200 + 0 + 60 + 20 + 0 + 5 + 1 + 5)
  })

  it("窗口外行不计入（o1 只在 -40d）", () => {
    const s = dao.reportSummary(A_START, C_END)
    expect(s.total_calls).toBe(8)
    expect(s.total_cost_usd!).toBeLessThan(100) // 无 o1 的 999
    expect(s.input_tokens).toBe(1748) // 无 o1 的 111（手算 1000+10+30+700+0+5+1+2）
  })

  it("与 SQL 直查交叉（独立真相源）", () => {
    const s = dao.reportSummary(A_START, C_END)
    const sql = db.prepare(`
      SELECT COUNT(*) total_calls,
             SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) priced_calls,
             COALESCE(SUM(input_tokens), 0) input_tokens,
             COALESCE(SUM(output_tokens), 0) output_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) cache_creation_tokens,
             COALESCE(SUM(cache_read_tokens), 0) cache_read_tokens,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) total_cost_usd
      FROM llm_calls WHERE model = 'E2E_TEST_R3_M' AND timestamp >= ? AND timestamp <= ?
    `).get(A_START, C_END) as Record<string, number | null>
    expect({
      total_calls: s.total_calls, priced_calls: s.priced_calls,
      input_tokens: s.input_tokens, output_tokens: s.output_tokens,
      cache_creation_tokens: s.cache_creation_tokens, cache_read_tokens: s.cache_read_tokens,
      total_cost_usd: s.total_cost_usd,
    }).toEqual(sql)
  })

  it("空区间 → 全 0 结构（AC2），非 NULL 非 404 语义", () => {
    const s = dao.reportSummary(at(-100, 0), at(-100, 23, 59, 59, 999))
    expect(s).toEqual({
      total_cost_usd: 0, total_calls: 0, priced_calls: 0, unpriced_calls: 0,
      input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
    })
  })

  it("有行但全无 priced → cost NULL（KD4 不焊 0）", () => {
    const s = dao.reportSummary(at(0, 12, 30), at(0, 13, 30)) // 只罩住 c4（unpriced）
    expect(s.total_calls).toBe(1)
    expect(s.unpriced_calls).toBe(1)
    expect(s.total_cost_usd).toBeNull()
    expect(s.input_tokens).toBe(700)
  })
})

describe("reportTrend", () => {
  it("逐日聚合与手算一致；本地日界含 00:00:30 / 23:59:59.999 边界行（KD24）", () => {
    const t = dao.reportTrend(A_START, C_END)
    // date(timestamp/1000.0,'unixepoch','localtime') 本地分桶
    expect(t.map(d => d.day)).toEqual([dateStr(-2), dateStr(-1), dateStr(0)])
    // A: 1 行 1.0；B: 3 行(含 legacy) 10.0（尖峰 = 10× A，AC3 可辨识）；C: 4 行 0.7
    expect(t[0]).toEqual({ day: dateStr(-2), calls: 1, priced_calls: 1, cost_usd: 1 })
    expect(t[1].calls).toBe(3)
    expect(t[1].priced_calls).toBe(2)
    expect(t[1].cost_usd).toBeCloseTo(10, 10)
    expect(t[2].calls).toBe(4)
    expect(t[2].cost_usd).toBeCloseTo(0.7, 10)
  })

  it("与 SQL 本地化分桶直查交叉", () => {
    const t = dao.reportTrend(A_START, C_END)
    const sql = db.prepare(`
      SELECT date(timestamp / 1000.0, 'unixepoch', 'localtime') AS day, COUNT(*) AS calls,
             SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) AS priced_calls,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) AS cost_usd
      FROM llm_calls WHERE model = 'E2E_TEST_R3_M' AND timestamp >= ? AND timestamp <= ?
      GROUP BY day ORDER BY day ASC
    `).all(A_START, C_END) as Array<{ day: string; calls: number; priced_calls: number; cost_usd: number | null }>
    expect(t).toEqual(sql)
  })

  it("全 unpriced 日：calls>0、cost NULL（不焊 0）", () => {
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
})
