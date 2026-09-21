// 02 · 报表 API：breakdown + ranking 集成测试（billing-report-3 ticket 02）
// Seam: GET /api/system/billing/report/breakdown?group_by=model|vendor|source
//       GET /api/system/billing/report/ranking?by=workspace|session&limit=N
// Hono app.request() 进程内真实路由栈 + 真实 SQLite；行经 TokenUsageDAO.insertLlmCall
// 写入口落库；聚合值与 SQL 直查交叉 + 手算字面值（禁从被测 API 推导 —— R1-R8 Tautological 禁令）。
// 口径：数量含 unpriced、费用仅 priced（KD21/KD4）；USD 基准 + 展示币种双字段（KD22）；
// 厂商经 model→billing_price_config.vendor 关联，无价归 unknown（KD23）；本地时区日界含首尾（KD24）。
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
    cost_usd: null, cost_native: null, cost_currency: null, price_status: null,
    org: 'default', workflow_ref: null, node_id: null, session_id: null, instance_id: 'inst-02',
    ...over,
  }
}

/** priced = 三列快照齐；unpriced = 三列 NULL（KD4/phase1 写入口口径）。 */
function priced(usd: number, native: number, cur: string) {
  return { cost_usd: usd, cost_native: native, cost_currency: cur, price_status: 'priced' as const }
}
const UNPRICED = { cost_usd: null, cost_native: null, cost_currency: null, price_status: 'unpriced' as const }

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

  const billing = new BillingDAO(db)
  billing.createPrice({ id: 'p-m1', vendor: 'E2E_TEST_V1', model_id: 'E2E_TEST_M1', input_unit_price: 1, output_unit_price: 1, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD' })
  billing.createPrice({ id: 'p-m2', vendor: 'E2E_TEST_V2', model_id: 'E2E_TEST_M2', input_unit_price: 1, output_unit_price: 1, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'CNY' })
  // E2E_TEST_M3 故意不配价 → 厂商未知（KD23）

  const dao = new TokenUsageDAO(db)
  //            id    model  ts      workspace session  source        cost
  dao.insertLlmCall(row('r1', { model: 'E2E_TEST_M1', timestamp: D.day2b, workspace_id: 'ws-1', session_id: 's-1', source_path: 'workflow', ...priced(10, 10, 'USD') }))
  dao.insertLlmCall(row('r2', { model: 'E2E_TEST_M1', timestamp: D.day2a, workspace_id: 'ws-2', session_id: 's-1', source_path: 'workflow', ...priced(2.5, 17.5, 'CNY') }))
  dao.insertLlmCall(row('r3', { model: 'E2E_TEST_M1', timestamp: D.day3, workspace_id: 'ws-1', session_id: 'cs-1', source_path: 'interaction', ...UNPRICED }))
  dao.insertLlmCall(row('r4', { model: 'E2E_TEST_M2', timestamp: D.day3, workspace_id: 'ws-2', session_id: 'cs-1', source_path: 'interaction', ...priced(40, 280, 'CNY') }))
  dao.insertLlmCall(row('r5', { model: 'E2E_TEST_M3', timestamp: D.day1, workspace_id: 'ws-1', session_id: 's-1', source_path: 'unknown', ...UNPRICED }))
  dao.insertLlmCall(row('r6', { model: 'E2E_TEST_M2', timestamp: D.day4, workspace_id: 'ws-3', session_id: null, source_path: 'harness', ...UNPRICED }))
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE model LIKE 'E2E_TEST_%'").run()
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
  it('by=workspace：TOP 序 = SQL SUM(cost_usd) DESC，name 取 workspaces.name（AC2/US4）', async () => {
    const { status, body } = await get(RANKING, '?by=workspace')
    expect(status).toBe(200)
    const items = body.items as RankingItem[]
    // 手算：ws-2 = r2(2.5)+r4(40)=42.5/2行；ws-1 = r1(10)+r3+r5(UP)=10/3行；ws-3 = r6(UP) → NULL/1行垫底
    expect(items.map(i => i.id)).toEqual(['ws-2', 'ws-1', 'ws-3'])
    expect(items.map(i => i.name)).toEqual(['WS Beta', 'WS Alpha', 'WS Gamma'])
    expect(items[0]).toMatchObject({ cost_usd: 42.5, cost_display: 297.5, calls: 2 })
    expect(items[1]).toMatchObject({ cost_usd: 10, calls: 3 }) // unpriced 计数量不计费用（KD21）
    expect(items[2]).toMatchObject({ cost_usd: null, cost_display: null, calls: 1 })
    // SQL ORDER BY LIMIT 交叉
    const sqlRows = getDb().prepare(`
      SELECT COALESCE(workspace_id, 'unknown') AS id,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) AS c, COUNT(*) AS calls
      FROM llm_calls WHERE model LIKE 'E2E_TEST_%'
      GROUP BY COALESCE(workspace_id, 'unknown')
      ORDER BY COALESCE(SUM(CASE WHEN price_status = 'priced' THEN cost_usd END), -1) DESC, id ASC
      LIMIT 50
    `).all() as { id: string; c: number | null; calls: number }[]
    expect(items.map(i => i.id)).toEqual(sqlRows.map(r => r.id))
    expect(items.map(i => i.cost_usd)).toEqual(sqlRows.map(r => r.c))
  })

  it('by=session：sessions/chat_sessions 双表取可读名，NULL 会话归 unknown', async () => {
    const { status, body } = await get(RANKING, '?by=session')
    expect(status).toBe(200)
    const items = body.items as RankingItem[]
    // cs-1: r3(UP)+r4(40) → 40/2 '聊天甲'(chat_sessions)；s-1: r1+r2(12.5)+r5(UP) → 12.5/3 'Agent会话一'(sessions)
    expect(items.map(i => i.id)).toEqual(['cs-1', 's-1', 'unknown'])
    expect(items[0]).toMatchObject({ name: '聊天甲', cost_usd: 40, calls: 2 })
    expect(items[1]).toMatchObject({ name: 'Agent会话一', cost_usd: 12.5, calls: 3 })
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
    // 区间内 r1..r4：s-1 → 12.5/2（r5 排除）；cs-1 → 40/2；unknown 组不存在（r6 排除）
    expect(items.map(i => i.id)).toEqual(['cs-1', 's-1'])
    expect(items[1]).toMatchObject({ cost_usd: 12.5, calls: 2 })
  })
})

describe('GET /report/breakdown — group_by=vendor / source / 非法参数', () => {
  it('vendor = model→价格表 vendor 关联（KD23），无价模型归 unknown（全区间）', async () => {
    const { status, body } = await get(BREAKDOWN, '?group_by=vendor')
    expect(status).toBe(200)
    const items = itemsOf(body)
    // 手算（全部 r1..r6）：M2→V2: r4+r6 → cost 40, calls 2；M1→V1: r1+r2+r3 → 12.5, 3；M3 无价行→unknown: cost NULL, calls 1
    expect(items.map(i => i.key)).toEqual(['E2E_TEST_V2', 'E2E_TEST_V1', 'unknown'])
    expect(items[0]).toMatchObject({ key: 'E2E_TEST_V2', cost_usd: 40, calls: 2 })
    expect(items[1]).toMatchObject({ key: 'E2E_TEST_V1', cost_usd: 12.5, calls: 3 })
    expect(items[2]).toMatchObject({ key: 'unknown', cost_usd: null, cost_display: null, calls: 1, share: 0 })
    // SQL 直查交叉（JOIN 价格表独立复算）
    const sqlRows = getDb().prepare(`
      SELECT COALESCE(p.vendor, 'unknown') AS key,
             SUM(CASE WHEN l.price_status = 'priced' THEN l.cost_usd END) AS cost_usd,
             COUNT(*) AS calls
      FROM llm_calls l LEFT JOIN billing_price_config p ON p.model_id = l.model
      WHERE l.model LIKE 'E2E_TEST_%'
      GROUP BY COALESCE(p.vendor, 'unknown')
    `).all() as { key: string; cost_usd: number | null; calls: number }[]
    for (const s of sqlRows) {
      const it = items.find(i => i.key === s.key)!
      expect(it.cost_usd).toBe(s.cost_usd)
      expect(it.calls).toBe(s.calls)
    }
  })

  it('source 分布：NULL 来源归 unknown 惯例同 sourceSubtotals；share 和=1', async () => {
    const { status, body } = await get(BREAKDOWN, '?group_by=source')
    expect(status).toBe(200)
    const items = itemsOf(body)
    // 手算：interaction r4(priced 40)+r3(unpriced) → 40/2；workflow r1+r2 → 12.5/2；
    // unknown r5 → NULL/1；harness r6 → NULL/1。NULL 费用组垫底、费用并列按 key 升序（harness < unknown）
    expect(items.map(i => i.key)).toEqual(['interaction', 'workflow', 'harness', 'unknown'])
    expect(items[0]).toMatchObject({ cost_usd: 40, calls: 2 })
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
    // 手算（区间内 r1..r4）：M2=40（1行）；M1=12.5（r1,r2,r3 三行，r3 未定价计数量不计费用）
    expect(items.map(i => i.key)).toEqual(['E2E_TEST_M2', 'E2E_TEST_M1'])
    expect(items[0]).toMatchObject({ key: 'E2E_TEST_M2', cost_usd: 40, calls: 1 })
    expect(items[1]).toMatchObject({ key: 'E2E_TEST_M1', cost_usd: 12.5, calls: 3 })
    // share = 费用占比（40/52.5, 12.5/52.5），和 = 1 ±1e-6
    expect(items[0].share).toBeCloseTo(40 / 52.5, 10)
    expect(items.reduce((s, i) => s + i.share, 0)).toBeCloseTo(1, 6)
  })

  it('与 SQL 直查交叉：GROUP BY model + priced 费用 + 全行计数（独立真相源）', async () => {
    const { body } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    const sqlRows = getDb().prepare(`
      SELECT model AS key,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) AS cost_usd,
             COUNT(*) AS calls
      FROM llm_calls
      WHERE model LIKE 'E2E_TEST_%' AND timestamp >= ? AND timestamp <= ?
      GROUP BY model
    `).all(D.day2a, D.day3 + 999) as { key: string; cost_usd: number | null; calls: number }[]
    const items = itemsOf(body)
    for (const s of sqlRows) {
      const it = items.find(i => i.key === s.key)
      expect(it, s.key).toBeTruthy()
      expect(it!.cost_usd).toBe(s.cost_usd)
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

  it('cost_display = USD 基准 × 服务端当时汇率（KD22/US6，默认 7.0 CNY）', async () => {
    const { status, body } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    expect(status).toBe(200)
    expect(body.display_currency).toBe('CNY')
    expect(body.usd_to_cny).toBe(7)
    const items = itemsOf(body)
    expect(items[0].cost_display).toBeCloseTo(280, 10)
    expect(items[1].cost_display).toBeCloseTo(87.5, 10)
    // 改汇率即时生效（同一汇率驱动报表与明细）
    new BillingDAO(getDb()).setSetting('usd_to_cny', '8')
    const { body: b2 } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    expect(itemsOf(b2)[0].cost_display).toBeCloseTo(320, 10)
    // 展示币种 USD → cost_display 恒等 cost_usd
    const bd = new BillingDAO(getDb())
    bd.setSetting('usd_to_cny', '7')
    bd.setSetting('display_currency', 'USD')
    const { body: b3 } = await get(BREAKDOWN, `?group_by=model&from=${FROM}&to=${TO}`)
    expect(b3.display_currency).toBe('USD')
    expect(itemsOf(b3)[0].cost_display).toBe(itemsOf(b3)[0].cost_usd)
    bd.setSetting('display_currency', 'CNY')
  })
})
