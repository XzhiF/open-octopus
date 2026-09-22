// packages/server/src/db/__tests__/price-sql.test.ts
//
// billing NEW-r2 —— llm_calls_costed 视图 = 全库算价唯一实现。这里钉语义：
// 兜底/窗口/优先级/去重/双币种/NULL 不焊 0。手算期望独立于被测 SQL
// （JS 直接算 Σ(token×单价)/1e6），价行用裸 INSERT 构造（绕开 DAO 校验，
// 才能测出「库被手改出重叠窗口」时视图的兜底去重行为）。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../schema"

let db: Database.Database

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
})
afterAll(() => { db.close() })

const DAY = 86_400_000
const T0 = 1_700_000_000_000 // 一个固定时刻（毫秒）

function seedPrice(o: {
  id: string; model: string; in?: number; out?: number; cw?: number; cr?: number
  from?: number | null; to?: number | null; currency?: "USD" | "CNY"
}) {
  db.prepare(`
    INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price,
      cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES (?, 'seed', ?, ?, ?, ?, ?, ?, ?, ?, 't', 't')
  `).run(o.id, o.model, o.in ?? 0, o.out ?? 0, o.cw ?? 0, o.cr ?? 0, o.currency ?? "USD",
    o.from ?? null, o.to ?? null)
}

function seedCall(id: string, model: string | null, ts: number, u = { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0 }) {
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, model,
      timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path)
    VALUES (?, NULL, NULL, 1, 0, ?, ?, 1, ?, ?, ?, ?, 'workflow')
  `).run(id, model, ts, u.in, u.out, u.cr, u.cw)
}

function costOf(id: string): number | null {
  return (db.prepare("SELECT cost_usd FROM llm_calls_costed WHERE id = ?").get(id) as { cost_usd: number | null }).cost_usd
}
function vendorOf(id: string): string | null {
  return (db.prepare("SELECT vendor FROM llm_calls_costed WHERE id = ?").get(id) as { vendor: string | null }).vendor
}

describe("llm_calls_costed 视图语义", () => {
  it("无价模型 → cost NULL（unpriced 不焊 0）；model NULL 同样 NULL", () => {
    seedCall("n-1", "no-price-model", T0)
    seedCall("n-2", null, T0)
    expect(costOf("n-1")).toBeNull()
    expect(costOf("n-2")).toBeNull()
    expect(vendorOf("n-1")).toBeNull()
  })

  it("USD 兜底价：Σ(token×单价)/1e6，全历史命中（含配价之前的行）", () => {
    seedCall("usd-1", "m-usd", T0 - 365 * DAY) // 比价行"出生"早一年 —— 查询时算 = 立即回算
    seedCall("usd-2", "m-usd", T0)
    seedPrice({ id: "p-usd", model: "m-usd", in: 3, out: 15, cw: 3.75, cr: 0.3 })
    expect(costOf("usd-1")).toBeCloseTo(18, 9)   // (1e6×3 + 1e6×15)/1e6
    expect(costOf("usd-2")).toBeCloseTo(18, 9)
    expect(vendorOf("usd-2")).toBe("seed")
  })

  it("CNY 价行 → ÷ 当前 usd_to_cny 折 USD 基准；改汇率立即重算", () => {
    seedCall("cny-1", "m-cny", T0)
    seedPrice({ id: "p-cny", model: "m-cny", in: 7, out: 0, currency: "CNY" })
    expect(costOf("cny-1")).toBeCloseTo(1, 9)    // 7/1e6×1e6 = 7 CNY ÷ 7.0
    db.prepare(`INSERT INTO billing_setting (key, value) VALUES ('usd_to_cny', '3.5')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
    expect(costOf("cny-1")).toBeCloseTo(2, 9)    // 7 ÷ 3.5
    db.prepare("DELETE FROM billing_setting WHERE key = 'usd_to_cny'").run() // 复原默认
  })

  it("半开区间 [from, to)：含起日、不含止日；界外回退兜底价", () => {
    seedCall("w-before", "m-win", T0 - DAY)
    seedCall("w-at-from", "m-win", T0)           // == from → 命中窗口
    seedCall("w-inside", "m-win", T0 + DAY / 2)
    seedCall("w-at-to", "m-win", T0 + DAY)       // == to（下一日零点）→ 不含
    seedPrice({ id: "p-win-base", model: "m-win", in: 1, out: 0 })                 // 兜底
    seedPrice({ id: "p-win", model: "m-win", in: 5, out: 0, from: T0, to: T0 + DAY }) // 窗口
    expect(costOf("w-before")).toBeCloseTo(1, 9)
    expect(costOf("w-at-from")).toBeCloseTo(5, 9)
    expect(costOf("w-inside")).toBeCloseTo(5, 9)
    expect(costOf("w-at-to")).toBeCloseTo(1, 9)
  })

  it("窗口行优先于兜底价；重叠窗口（手改库）取 valid_from 最大且行不被复制翻倍", () => {
    seedCall("t-1", "m-dup", T0 + 10 * DAY)
    seedPrice({ id: "p-dup-base", model: "m-dup", in: 1, out: 0 })                          // 兜底
    seedPrice({ id: "p-dup-old", model: "m-dup", in: 2, out: 0, from: T0 })                 // 与"新"重叠（校验漏网）
    seedPrice({ id: "p-dup-new", model: "m-dup", in: 3, out: 0, from: T0 + 5 * DAY })
    // 聚合视角：行集仍是 1 行，钱 = 最新窗口（3），不是 2+3，也不是 (1+2+3)
    const agg = db.prepare(`
      SELECT COUNT(*) AS rows_n, SUM(cost_usd) AS total, COUNT(*) = COUNT(cost_usd) AS complete
      FROM llm_calls_costed WHERE model = 'm-dup'
    `).get() as { rows_n: number; total: number; complete: number }
    expect(agg.rows_n).toBe(1)
    expect(agg.total).toBeCloseTo(3, 9)
    expect(agg.complete).toBe(1)
  })

  it("贴边相接（from==上一段 to）各算各段，不重叠不遗漏", () => {
    seedCall("adj-1", "m-adj", T0)              // [T0, T0+DAY) 段
    seedCall("adj-2", "m-adj", T0 + DAY)        // [T0+DAY, T0+2DAY) 段
    seedPrice({ id: "p-adj-a", model: "m-adj", in: 4, out: 0, from: T0, to: T0 + DAY })
    seedPrice({ id: "p-adj-b", model: "m-adj", in: 6, out: 0, from: T0 + DAY, to: T0 + 2 * DAY })
    expect(costOf("adj-1")).toBeCloseTo(4, 9)
    expect(costOf("adj-2")).toBeCloseTo(6, 9)
  })

  it("视图行 = llm_calls 全列 + cost_usd + vendor；聚合三态与 PRICED_AGG 口径一致", () => {
    const agg = db.prepare(`
      SELECT COUNT(*) AS calls, COUNT(cost_usd) AS priced, SUM(cost_usd) AS sum_usd
      FROM llm_calls_costed WHERE model = 'm-usd'
    `).get() as { calls: number; priced: number; sum_usd: number }
    expect(agg.calls).toBe(2)
    expect(agg.priced).toBe(2)
    expect(agg.sum_usd).toBeCloseTo(36, 9)
    // 全未定价组：SUM → NULL（不焊 0）
    const none = db.prepare(`
      SELECT SUM(cost_usd) AS s FROM llm_calls_costed WHERE model = 'no-price-model'
    `).get() as { s: number | null }
    expect(none.s).toBeNull()
  })
})
