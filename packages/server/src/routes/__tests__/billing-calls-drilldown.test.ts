// 04 · 联动下钻筛选（billing-report-3 ticket 04，billing NEW-r2 改版）· API 集成测试
// Seam: 报表条目点击注入的筛选参数（session_id / vendor / workspace_id / source_path / 区间）
//       → GET /api/system/billing/calls 首行归属正确、行数 = SQL 直查（票面 Verification 步骤3；
//       点击后目标查询本身已在票 01/02 验证，此处只补"注入参数可执行且归属一致"）。
// NEW-r2：行只存事实，cost_usd/price_status 查询时按价行派生（DM1/DM2 兜底价：
// 每 1000 input token = 1 USD）。Hono app.request() 进程内真实路由栈 + 真实 SQLite；
// 期望值 SQL 逐行独立复算（禁自推 —— Tautological 禁令）。
// vendor 口径：model→billing_price_config 关联（KD9 全等，语义同 breakdown/KD23）；
// 归属 NULL 的 'unknown' 组下钻由前端降级为仅区间，不经 id 精确筛选（本票组件测试断言）。
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
const CALLS = '/api/system/billing/calls'

/** 出参行形状（事实列 + 派生钱列；NEW-r2 起无 cost_native/cost_currency）。 */
interface CallOut {
  id: string; model: string | null; timestamp: number; session_id: string | null
  workspace_id: string | null; source_path: string | null
  cost_usd: number | null; price_status: 'priced' | 'unpriced'
}

const T = {
  d1: new Date(2026, 8, 10, 9, 0, 0).getTime(),
  d2: new Date(2026, 8, 11, 10, 0, 0).getTime(),
  d3: new Date(2026, 8, 12, 11, 0, 0).getTime(),
  d4: new Date(2026, 8, 13, 12, 0, 0).getTime(),
  d5: new Date(2026, 8, 14, 13, 0, 0).getTime(),
}

function row(id: string, over: Partial<LlmCallRow> & { model: string | null; timestamp: number }): LlmCallRow {
  return {
    id, node_execution_id: null, execution_id: null, turn_index: 1, call_index: 0,
    message_id: null, stop_reason: null, duration_ms: 100, ttft_ms: null,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0,
    workspace_id: null, org: 'default', workflow_ref: null, node_id: null, session_id: null, instance_id: 'inst-04',
    ...over,
  }
}

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-drill-04-${process.pid}-${Date.now()}.db`)
  initDb(dbPath)
  const db = getDb()
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-drill-1','Drill One','/tmp/d1','default',?,?)").run(t, t)
  db.prepare("INSERT INTO sessions (id, org, title, created_at, updated_at) VALUES ('sess-drill-a','default','下钻会话A',?,?)").run(t, t)

  // DM1/DM2 兜底价：input 1000/1M、其余 0 → 每行（input=1000）派生 1 USD；DM3 不配价。
  const billing = new BillingDAO(db)
  billing.createPrice({ id: 'p-drill-m1', vendor: 'E2E_TEST_DV1', model_id: 'E2E_TEST_DM1', input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD' })
  billing.createPrice({ id: 'p-drill-m2', vendor: 'E2E_TEST_DV2', model_id: 'E2E_TEST_DM2', input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD' })
  // E2E_TEST_DM3 故意不配价 → 厂商 unknown（组件测试断言其点击降级）

  const dao = new TokenUsageDAO(db)
  // sess-drill-a 3 行（最新 d5 = DM2/priced）、sess-drill-b 2 行、NULL session 1 行
  dao.insertLlmCall(row('dr-1', { model: 'E2E_TEST_DM1', timestamp: T.d1, workspace_id: 'ws-drill-1', session_id: 'sess-drill-a', source_path: 'workflow' }))
  dao.insertLlmCall(row('dr-2', { model: 'E2E_TEST_DM2', timestamp: T.d2, workspace_id: 'ws-drill-1', session_id: 'sess-drill-b', source_path: 'interaction' }))
  dao.insertLlmCall(row('dr-3', { model: 'E2E_TEST_DM3', timestamp: T.d3, workspace_id: 'ws-other', session_id: 'sess-drill-a', source_path: 'harness' }))
  dao.insertLlmCall(row('dr-4', { model: 'E2E_TEST_DM1', timestamp: T.d4, workspace_id: null, session_id: null, source_path: 'global_chat' }))
  dao.insertLlmCall(row('dr-5', { model: 'E2E_TEST_DM2', timestamp: T.d5, workspace_id: 'ws-drill-1', session_id: 'sess-drill-a', source_path: 'interaction' }))
  // 非本票数据（同库其他行）不应被筛选命中 —— 时间/归属均不同
  dao.insertLlmCall(row('dr-x', { model: 'E2E_TEST_DM1', timestamp: T.d5, workspace_id: 'ws-noise', session_id: 'sess-noise', source_path: 'workflow' }))
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE model LIKE 'E2E_TEST_D%'").run()
  getDb().prepare("DELETE FROM billing_price_config WHERE model_id LIKE 'E2E_TEST_D%'").run()
  const left = (getDb().prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE model LIKE 'E2E_TEST_D%'").get() as { n: number }).n
  expect(left).toBe(0) // 清理复核
  closeDb()
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

async function get(params: string): Promise<{ status: number; body: { calls: CallOut[]; total: number } }> {
  const res = await app.request(`${CALLS}${params}`)
  return { status: res.status, body: await res.json() }
}
function sqlCount(where: string, ...args: unknown[]): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE ${where}`).get(...args) as { n: number }).n
}

describe('下钻筛选注入 → GET /calls（票04 验证步骤3）', () => {
  it('session 排行第 1 点击注入 session_id → 首行归属正确、行数 = SQL 直查', async () => {
    const { status, body } = await get('?session_id=sess-drill-a')
    expect(status).toBe(200)
    // SQL 交叉：sess-drill-a = dr-1(d1) + dr-3(d3) + dr-5(d5) = 3 行
    expect(body.total).toBe(sqlCount("session_id = 'sess-drill-a' AND model LIKE 'E2E_TEST_D%'"))
    expect(body.total).toBe(3)
    // timestamp 倒序 → 首行 = dr-5（归属 session 正确、模型正确）
    expect(body.calls[0].id).toBe('dr-5')
    expect(body.calls.map(r => r.session_id)).toEqual(['sess-drill-a', 'sess-drill-a', 'sess-drill-a'])
    // 未配价行仍计入数量筛选（KD21：下钻是行筛选不是费用筛选）；price_status = 派生
    expect(body.calls.map(r => r.id)).toContain('dr-3')
    const dr3 = body.calls.find(r => r.id === 'dr-3')!
    expect(dr3).toMatchObject({ cost_usd: null, price_status: 'unpriced' })
    expect(body.calls.find(r => r.id === 'dr-5')).toMatchObject({ cost_usd: 1, price_status: 'priced' }) // 1000×1000/1M
  })

  it('厂商分布点击注入 vendor → 行数 = SQL（model→价行关联），未配价行不入', async () => {
    const { status, body } = await get('?vendor=E2E_TEST_DV1')
    expect(status).toBe(200)
    const sql = sqlCount("model IN (SELECT model_id FROM billing_price_config WHERE vendor = 'E2E_TEST_DV1') AND model LIKE 'E2E_TEST_D%'")
    expect(body.total).toBe(sql)
    expect(body.total).toBe(3) // dr-1 + dr-4 + dr-x（DM1 全部行，含 NULL 归属）
    expect(body.calls.every(r => r.model === 'E2E_TEST_DM1')).toBe(true)
    // DM1 为兜底价 → 全时段行都派生出钱
    expect(body.calls.every(r => r.price_status === 'priced' && r.cost_usd === 1)).toBe(true)
    // DM3 无价行（dr-3）不被任何具名厂商命中 —— unknown 组无 model 可筛，前端降级仅区间
    const unknown = await get('?vendor=E2E_TEST_NOPE')
    expect(unknown.body.total).toBe(0)
  })

  it('workspace 排行点击注入 workspace_id + 保留区间（from/to 含界）→ 行数 = SQL', async () => {
    const from = new Date(2026, 8, 11, 0, 0, 0).getTime()
    const to = new Date(2026, 8, 15, 23, 59, 59).getTime()
    const { status, body } = await get(`?workspace_id=ws-drill-1&from=${from}&to=${to}`)
    expect(status).toBe(200)
    // ws-drill-1 行：dr-1(d1=9/10,界外) dr-2(d2=9/11) dr-5(d5=9/14) → 区间内 = 2
    expect(body.total).toBe(sqlCount(`workspace_id = 'ws-drill-1' AND timestamp >= ${from} AND timestamp <= ${to} AND model LIKE 'E2E_TEST_D%'`))
    expect(body.total).toBe(2)
    expect(body.calls[0].id).toBe('dr-5')
    expect(body.calls[1].id).toBe('dr-2')
  })

  it('来源分布点击注入 source_path（含 unknown 兜 NULL 口径不变）', async () => {
    const interaction = await get('?source_path=interaction')
    expect(interaction.body.total).toBe(sqlCount("source_path = 'interaction' AND model LIKE 'E2E_TEST_D%'"))
    expect(interaction.body.total).toBe(2) // dr-2 + dr-5
    // 模型分布 'unknown'（model NULL）明细端点无对应可筛值 —— 但具名模型下钻照常精确匹配
    const m = await get('?model=E2E_TEST_DM3')
    expect(m.body.total).toBe(1)
    expect(m.body.calls[0].id).toBe('dr-3')
    expect(m.body.calls[0]).toMatchObject({ cost_usd: null, price_status: 'unpriced' }) // 派生：DM3 无价行
  })
})
