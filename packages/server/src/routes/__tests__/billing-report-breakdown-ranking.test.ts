// 02 · 报表 API：breakdown + ranking 集成测试（billing-report-3 ticket 02，billing NEW-r2 改版）
// Seam: GET /api/system/billing/report/breakdown?group_by=model|vendor|source
//       GET /api/system/billing/report/ranking?by=workspace|session&limit=N
// NEW-r2：行只存事实；报表费用/厂商 = 查询时按价行窗口匹配派生。本夹具用「时间段价」构造
// 同模型不同时刻有无价格的差异（r3/r6 窗口外 → unpriced NULL，不焊 0，KD4/KD21）。
// Hono app.request() 进程内真实路由栈 + 真实 SQLite；聚合值与 SQL 直查交叉 + 手算字面值
// （禁从被测 API 推导 —— R1-R8 Tautological 禁令）。
// 厂商经 model→命中价行.vendor 关联，无命中归 unknown（KD23）；本地时区日界含首尾（KD24）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../../db/connection'
import { createSystemRoutes } from '../system'
import { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import { BillingDAO } from '../../db/dao/billing-dao'
import type { LlmCallRow } from '../../db/types'

const system = createSystemRoutes()
const app = new Hono().route('/api/system', system)

let dbPath: string

const BREAKDOWN = '/api/system/billing/report/breakdown'
const RANKING = '/api/system/billing/report/ranking'

// 本地时区日期锚点（KD24：日界 = 本地 0 点）
const D = {
  day1: new Date(2026, 8, 15, 12, 0, 0).getTime(),  // 区间外（早于 from）
  day2a: new Date(2026, 8, 16, 0, 0, 0).getTime(),  // from 日本地 0 点 = 含
  day2b: new Date(2026, 8, 16, 12, 0, 0).getTime(),
  day3: new Date(2026, 8, 17, 23, 59, 59).getTime(),// to 日最后一刻 = 含
  day4: new Date(2026, 8, 18, 0, 0, 0).getTime(),   // 区间外（晚于 to 日）
}
const FROM = '2026-09-16'
const TO = '2026-09-17'

function row(id: string, over: Partial<LlmCallRow> & { model: string | null; timestamp: number; workspace_id: string | null }): LlmCallRow {
  return {
    id, node_execution_id: null, execution_id: null, turn_index: 1, call_index: 0,
    message_id: null, stop_reason: null, duration_ms: 100, ttft_ms: null,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0,
    org: 'default', workflow_ref: null, node_id: null, session_id: null, instance_id: 'inst-02',
    ...over,
  }
}

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-report-02-${process.pid}-${Date.now()}.db`)
  initDb(dbPath)
  const db = getDb()
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS Alpha','/tmp/1','default',?,?)").run(t, t)
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-2','WS Beta','/tmp/2','default',?,?)").run(t, t)
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-3','WS Gamma','/tmp/3','default',?,?)").run(t, t)
  db.prepare("INSERT INTO sessions (id, org, title, created_at, updated_at) VALUES ('s-1','default','Agent会话一',?,?)").run(t, t)
  db.prepare("INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES ('cs-1','ws-1','聊天甲',?,?)").run(t, t)

  // 时间段价（NEW-r2 夹具核心）：
  //   M1 USD input 10000/1M，窗口 [9/16, 9/17)：r1=10、r2(250 token)=2.5；r3 在窗口外 → unpriced；
  //   M2 CNY input 280000/1M，窗口 [9/17, 9/18)：r4 = 280 CNY ÷7 = 40 USD；r6 恰在 to 界（半开=排除）→ unpriced。
  //   M3 故意永不配价 → 厂商未知（KD23）。
  const billing = new BillingDAO(db)
  billing.createPrice({ id: 'p-m1', vendor: 'E2E_TEST_V1', model_id: 'E2E_TEST_M1', input_unit_price: 10000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD', valid_from: D.day2a, valid_to: new Date(2026, 8, 17).getTime() })
  billing.createPrice({ id: 'p-m2', vendor: 'E2E_TEST_V2', model_id: 'E2E_TEST_M2', input_unit_price: 280000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'CNY', valid_from: new Date(2026, 8, 17).getTime(), valid_to: D.day4 })

  const dao = new TokenUsageDAO(db)
  //            id    model  ts      workspace session  source      input
  dao.insertLlmCall(row('r1', { model: 'E2E_TEST_M1', timestamp: D.day2b, workspace_id: 'ws-1', session_id: 's-1', source_path: 'workflow' })) // 10
  dao.insertLlmCall(row('r2', { model: 'E2E_TEST_M1', timestamp: D.day2a, workspace_id: 'ws-2', session_id: 's-1', source_path: 'workflow', input_tokens: 250 })) // 2.5
  dao.insertLlmCall(row('r3', { model: 'E2E_TEST_M1', timestamp: D.day3, workspace_id: 'ws-1', session_id: 'cs-1', source_path: 'interaction' })) // 窗口外 → unpriced
  dao.insertLlmCall(row('r4', { model: 'E2E_TEST_M2', timestamp: D.day3, workspace_id: 'ws-2', session_id: 'cs-1', source_path: 'interaction' })) // 280CNY→40
  dao.insertLlmCall(row('r5', { model: 'E2E_TEST_M3', timestamp: D.day1, workspace_id: 'ws-1', session_id: 's-1', source_path: 'unknown' })) // 无价模型
  dao.insertLlmCall(row('r6', { model: 'E2E_TEST_M2', timestamp: D.day4, workspace_id: 'ws-3', session_id: null, source_path: 'harness' })) // to 界外 → unpriced
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE model LIKE 'E2E_TEST_%'").run()
  getDb().prepare("DELETE FROM billing_price_config WHERE model_id LIKE 'E2E_TEST_%'").run()
  const left = (getDb().prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE model LIKE 'E2E_TEST_%'").get() as { n: number }).n
  expect(left).toBe(0) // 清理复核
  closeDb()
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

async function get(url: string, params = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`${url}${params}`)
  return { status: res.status, body: await res.json() }
}

interface BreakdownItem { key: string; cost_usd: number | null; cost_display: number | null; calls: number; share: number }
function itemsOf(body: Record<string, unknown>): BreakdownItem[] {
  return body.items as BreakdownItem[]
}

interface RankingItem { id: string; name: string; cost_usd: number | null; cost_display: number | null; calls: number }

describe('GET /report/ranking', () => {
  it('by=workspace：TOP 序 = 视图 SUM(cost_usd) DESC，name 取 workspaces.name（AC2/US4）', async () => {
    const { status, body } = await get(RANKING, '?by=workspace')
    expect(status).toBe(200)
    const items = body.items as RankingItem[]
    // 手算：ws-2 = r2(2.5)+r4(40)=42.5/2行；ws-1 = r1(10)+r3+r5(UP)=10/3行；ws-3 = r6(窗口外 UP) → NULL/1行垫底
    expect(items.map(i => i.id)).toEqual(['ws-2', 'ws-1', 'ws-3'])
    expect(items.map(i => i.name)).toEqual(['WS Beta', 'WS Alpha', 'WS Gamma'])
    expect(items[0]).toMatchObject({ cost_usd: expect.closeTo(42.5, 10), cost_display: expect.closeTo(297.5, 10), calls: 2 })
    expect(items[1]).toMatchObject({ cost_usd: expect.closeTo(10, 10), calls: 3 }) // unpriced 计数量不计费用（KD21）
    expect(items[2]).toMatchObject({ cost_usd: null, cost_display: null, calls: 1 })
    // SQL ORDER BY LIMIT 交叉（派生钱走视图）
    const sqlRows = getDb().prepare(`
      SELECT COALESCE(workspace_id, 'unknown') AS id,
             SUM(cost_usd) AS c, COUNT(*) AS calls
      FROM llm_calls_costed WHERE model LIKE 'E2E_TEST_%'
      GROUP BY COALESCE(workspace_id, 'unknown')
      ORDER BY COALESCE(SUM(cost_usd), -1) DESC, id ASC
      LIMIT 50
    `).all() as { id: string; c: number | null; calls: number }[]
    expect(items.map(i => i.id)).toEqual(sqlRows.map(r => r.id))
    items.forEach((i, n) => {
      if (i.cost_usd === null) expect(sqlRows[n].c).toBeNull()
      else expect(i.cost_usd).toBeCloseTo(sqlRows[n].c as number, 10)
    })
  })

  it('by=session：sessions/chat_sessions 双表取可读名，NULL 会话归 unknown', async () => {
    const { status, body } = await get(RANKING, '?by=session')
    expect(status).toBe(200)
    const items = body.items as RankingItem[]
    // cs-1: r3(UP)+r4(40) → 40/2 '聊天甲'(chat_sessions)；s-1: r1+r2(12.5)+r5(UP) → 12.5/3 'Agent会话一'(sessions)
    expect(items.map(i => i.id)).toEqual(['cs-1', 's-1', 'unknown'])
    expect(items[0]).toMatchObject({ name: '聊天甲', cost_usd: expect.closeTo(40, 10), calls: 2 })
    expect(items[1]).toMatchObject({ name: 'Agent会话一', cost_usd: expect.closeTo(12.5, 10), calls: 3 })
    expect(items[2]).toMatchObject({ name: 'unknown', cost_usd: null, calls: 1 }) // 取不到名字显示 id
  })

  it('limit：默认 10、N≤50 生效、越界 400；by/group_by 非法 400（AC2/KD25）', async () => {
    const def = await get(RANKING, '?by=workspace')
    expect(def.body.limit).toBe(10)
    const one = await get(RANKING, '?by=workspace&limit=1')
    expect((one.body.items as RankingItem[]).map(i => i.id)).toEqual(['ws-2'])
    const capped = await get(RANKING, '?by=workspace&limit=50')
    expect(capped.status).toBe(200)
    for (const q of ['?by=workspace&limit=51', '?by=workspace&limit=0', '?by=workspace&limit=abc', '?by=model', '?by=vendor', '']) {
      const { status, body } = await get(RANKING, q)
      expect(status, q).toBe(400)
      expect((body.error as { code?: string })?.code).toBeTruthy()
    }
  })

  it('from/to 日期界对排行同样生效（KD24）', async () => {
    const { body } = await get(RANKING, `?by=session&from=${FROM}&to=${TO}`)
    const items = body.items as RankingItem[]
    // 区间内 r1..r4：s-1 → 12.5/2（r5 排除）；cs-1 → 40/2（r3 未定价计数量）；unknown 组不存在（r6 排除）
    expect(items.map(i => i.id)).toEqual(['cs-1', 's-1'])
    expect(items[1]).toMatchObject({ cost_usd: expect.closeTo(12.5, 10), calls: 2 })
  })
})

describe('GET /report/breakdown — group_by=vendor / source / 非法参数', () => {
  it('vendor = model→命中价行 vendor 关联（KD23），窗口未命中/无价模型归 unknown（全区间）', async () => {
    const { status, body } = await get(BREAKDOWN, '?group_by=vendor')
    expect(status).toBe(200)
    const items = itemsOf(body)
    // 手算（全部 r1..r6）：M2→V2: 仅 r4 命中窗口 → 40, calls 1（r6 在窗口外无厂商 → unknown）；
    //   M1→V1: r1+r2 → 12.5, 2（r3 窗口外 → unknown）；M3 无价行 + r3 + r6 → unknown: cost NULL, calls 3
    expect(items.map(i => i.key)).toEqual(['E2E_TEST_V2', 'E2E_TEST_V1', 'unknown'])
    expect(items[0]).toMatchObject({ key: 'E2E_TEST_V2', cost_usd: expect.closeTo(40, 10), calls: 1 })
    expect(items[1]).toMatchObject({ key: 'E2E_TEST_V1', cost_usd: expect.closeTo(12.5, 10), calls: 2 })
    expect(items[2]).toMatchObject({ key: 'unknown', cost_usd: null, cost_display: null, calls: 3, share: 0 })
    // SQL 直查交叉（视图 vendor 列 + LEFT JOIN 价格表窗口匹配的独立复算）
    const sqlRows = getDb().prepare(`
      SELECT COALESCE(vendor, 'unknown') AS key, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
      FROM llm_calls_costed WHERE model LIKE 'E2E_TEST_%'
      GROUP BY COALESCE(vendor, 'unknown')
    `).all() as { key: string; cost_usd: number | null; calls: number }[]
    for (const s of sqlRows) {
      const it = items.find(i => i.key === s.key)!
      if (s.cost_usd === null) expect(it.cost_usd, s.key).toBeNull()
      else expect(it.cost_usd, s.key).toBeCloseTo(s.cost_usd, 10)
      expect(it.calls, s.key).toBe(s.calls)
    }
  })

  it('source 分布：NULL 来源归 unknown 惯例同 sourceSubtotals；share 和=1', async () => {
    const { status, body } = await get(BREAKDOWN, '?group_by=source')
    expect(status).toBe(200)
    const items = itemsOf(body)
    // 手算：interaction r4(priced 40)+r3(unpriced) → 40/2；workflow r1+r2 → 12.5/2；
    // unknown r5 → NULL/1；harness r6 → NULL/1。NULL 费用组垫底、费用并列按 key 升序（harness < unknown）
    expect(items.map(i => i.key)).toEqual(['interaction', 'workflow', 'harness', 'unknown'])
    expect(items[0]).toMatchObject({ cost_usd: expect.closeTo(40, 10), calls: 2 })
    expect(items.reduce((s, i) => s + i.share, 0)).toBeCloseTo(1, 6)
    expect(items.reduce((s, i) => s + i.calls, 0)).toBe(6) // 数量类含 unpriced（KD21）
  })

  it('group_by 非法 / 日期非法 → 400 带 code（AC3）', async () => {
    for (const q of ['?group_by=nope', '?group_by=session', '?group_by=model&from=abc', '?group_by=model&from=2026-13-45', '?group_by=model&to=2026-02-30', '?group_by=model&from=-5']) {
      const { status, body } = await get(BREAKDOWN, q)
      expect(status, q).toBe(400)
      expect((body.error as { code?: string })?.code).toBeTruthy()
    }
  })
})

describe('GET /report/breakdown — group_by=model', () => {
  it('费用降序 + 数量含 unpriced 费用仅 priced + share 之和=1（AC1/US3/US5）', async () => {
    const { status, body } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    expect(status).toBe(200)
    const items = itemsOf(body)
    // 手算（区间内 r1..r4）：M2=40（1行）；M1=12.5（r1,r2,r3 三行，r3 窗口外未定价计数量不计费用）
    expect(items.map(i => i.key)).toEqual(['E2E_TEST_M2', 'E2E_TEST_M1'])
    expect(items[0]).toMatchObject({ key: 'E2E_TEST_M2', cost_usd: expect.closeTo(40, 10), calls: 1 })
    expect(items[1]).toMatchObject({ key: 'E2E_TEST_M1', cost_usd: expect.closeTo(12.5, 10), calls: 3 })
    // share = 费用占比（40/52.5, 12.5/52.5），和 = 1 ±1e-6
    expect(items[0].share).toBeCloseTo(40 / 52.5, 10)
    expect(items.reduce((s, i) => s + i.share, 0)).toBeCloseTo(1, 6)
  })

  it('与 SQL 直查交叉：GROUP BY model + 派生费用 + 全行计数（独立真相源）', async () => {
    const { body } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    const sqlRows = getDb().prepare(`
      SELECT model AS key, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
      FROM llm_calls_costed
      WHERE model LIKE 'E2E_TEST_%' AND timestamp >= ? AND timestamp <= ?
      GROUP BY model
    `).all(D.day2a, D.day3 + 999) as { key: string; cost_usd: number | null; calls: number }[]
    const items = itemsOf(body)
    for (const s of sqlRows) {
      const it = items.find(i => i.key === s.key)
      expect(it, s.key).toBeTruthy()
      if (s.cost_usd === null) expect(it!.cost_usd).toBeNull()
      else expect(it!.cost_usd).toBeCloseTo(s.cost_usd, 10)
      expect(it!.calls).toBe(s.calls)
    }
    expect(items.length).toBe(sqlRows.length)
  })

  it('KD24 本地日界：from 日 0 点含、to 日最后一刻含、外沿日排除', async () => {
    const { body } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    const items = itemsOf(body)
    // r5(day1) / r6(day4) 排除；若边界错（UTC 或不含界）则行数/费用对不上
    expect(items.reduce((s, i) => s + i.calls, 0)).toBe(4)
  })

  it('cost_display = USD 基准 × 当时汇率；改汇率同时回算 CNY 价行的 USD（NEW-r2 汇率即时性）', async () => {
    const { status, body } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    expect(status).toBe(200)
    expect(body.display_currency).toBe('CNY')
    expect(body.usd_to_cny).toBe(7)
    const items = itemsOf(body)
    expect(items[0].key).toBe('E2E_TEST_M2')
    expect(items[0].cost_display).toBeCloseTo(280, 10) // 40 USD × 7
    expect(items[1].cost_display).toBeCloseTo(87.5, 10) // 12.5 USD × 7
    // 改汇率 → CNY 价行的派生 USD 立即重算（280/8 = 35），展示值乘回来恒为原币 280；
    // USD 价行不受汇率影响，仅展示换算随动（12.5 × 8 = 100）。同一汇率驱动报表与明细。
    new BillingDAO(getDb()).setSetting('usd_to_cny', '8')
    const { body: b2 } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    const it2 = itemsOf(b2)
    expect(it2[0]).toMatchObject({ key: 'E2E_TEST_M2', cost_usd: expect.closeTo(35, 10) })
    expect(it2[0].cost_display).toBeCloseTo(280, 10)
    expect(it2[1].cost_display).toBeCloseTo(100, 10)
    // 展示币种 USD → cost_display 恒等 cost_usd
    const bd = new BillingDAO(getDb())
    bd.setSetting('usd_to_cny', '7')
    bd.setSetting('display_currency', 'USD')
    const { body: b3 } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    expect(b3.display_currency).toBe('USD')
    expect(itemsOf(b3)[0].cost_display).toBe(itemsOf(b3)[0].cost_usd)
    bd.setSetting('display_currency', 'CNY')
  })

  it('改价即回算：给 r3/r6 补兜底价 → 费用立变；删价回落（NEW-r2 语义）', async () => {
    const billing = new BillingDAO(getDb())
    const before = itemsOf((await get(BREAKDOWN, '?group_by=model')).body)
    expect(before.find(i => i.key === 'E2E_TEST_M1')!.cost_usd).toBeCloseTo(12.5, 10)
    // M1 补全时段兜底价（窗口价对 r1/r2 仍优先：兜底 1 ≠ 窗口 10）
    billing.createPrice({ id: 'p-m1-cat', vendor: 'E2E_TEST_V1', model_id: 'E2E_TEST_M1', input_unit_price: 1, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD' })
    const mid = itemsOf((await get(BREAKDOWN, '?group_by=model')).body)
    expect(mid.find(i => i.key === 'E2E_TEST_M1')!.cost_usd).toBeCloseTo(12.5 + 1000 / 1e6, 10) // r3 由 NULL → 0.001
    expect(billing.deletePrice('p-m1-cat')).toBe(true)
    const after = itemsOf((await get(BREAKDOWN, '?group_by=model')).body)
    expect(after.find(i => i.key === 'E2E_TEST_M1')!.cost_usd).toBeCloseTo(12.5, 10)
  })
})
