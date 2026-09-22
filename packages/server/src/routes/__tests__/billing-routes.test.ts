// 03 · 计费配置 API 集成测试（billing-core-1 ticket 03，billing NEW-r2 改版）
// Seam: /api/system/billing/prices CRUD（规则表：兜底价 + 时间段价）+ /billing/settings
//       + /billing/price-preview 试算。
// NEW-r2：窗口边界以 "YYYY-MM-DD" 进（服务端换本地零点 epoch ms）、以 epoch 出；
// 违例统一 400 + code（旧 409 DUPLICATE_MODEL_ID 已退役）；model_id 保存前归一化；
// 改价立即重算全部历史（查询时派生，钱不落账本）。
// 验证走 Hono app.request()（进程内真实路由栈 + 真实 SQLite），每步 API↔DB 交叉断言；
// 期望值手写在测试里。测试数据 E2E_TEST_ 前缀，尾部清理并复核。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../../db/connection'
import { createSystemRoutes } from '../system'
import { BillingDAO } from '../../db/dao/billing-dao'
import { TokenUsageDAO } from '../../db/dao/token-usage-dao'

let dbPath: string
const system = createSystemRoutes()
// 与 index.ts 相同挂载：路由全路径 = /api/system/...
const app = new Hono().route('/api/system', system)

const dao = () => new BillingDAO(getDb())

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-routes-${process.pid}-${Date.now()}.db`)
  initDb(dbPath)
})

afterAll(() => {
  closeDb()
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

function jsonReq(method: string, url: string, body: unknown) {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function listPrices(): Promise<Array<Record<string, unknown>>> {
  return (await (await app.request('/api/system/billing/prices')).json()).prices
}
/** 请求失败 → 断言 400 + 指定 code。 */
async function expect400(method: string, url: string, body: unknown, code: string): Promise<void> {
  const res = await jsonReq(method, url, body)
  const err = await res.json()
  expect(res.status, `${method} ${url} ${JSON.stringify(body)} → ${JSON.stringify(err)}`).toBe(400)
  expect(err.error?.code, `error.code for ${code}`).toBe(code)
}

const VALID_A = {
  vendor: 'E2E_TEST_vendor',
  model_id: 'E2E_TEST_MODEL_A',
  input_unit_price: 21,
  output_unit_price: 105,
  cache_write_unit_price: 26.25,
  cache_read_unit_price: 2.1,
  currency: 'CNY',
}
/** "YYYY-MM-DD" → 本地零点 epoch（与生产 priceDateToMs 同式的独立复算）。 */
function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

describe('GET /api/system/billing/prices + settings (初始态)', () => {
  it('prices 初始为空列表；settings 返回默认值兜底（票 01 口径）', async () => {
    const prices = await (await app.request('/api/system/billing/prices')).json()
    expect(prices).toEqual({ prices: [] })

    const res = await app.request('/api/system/billing/settings')
    expect(res.status).toBe(200)
    // AC: 字段名 = usd_to_cny / display_currency（web-app 契约）
    expect(await res.json()).toEqual({ usd_to_cny: '7.0', display_currency: 'CNY' })
  })
})

describe('/api/system/billing/prices CRUD（规则表：兜底价 + 时间段价；写入必验副作用 API↔DB）', () => {
  let aCatchallId = ''
  let aWindowId = ''

  it('POST 合法（无窗口字段 = 兜底价）→ 201，响应业务字段逐项 = 手写期望；DB SELECT 比对一致', async () => {
    const res = await jsonReq('POST', '/api/system/billing/prices', VALID_A)
    expect(res.status).toBe(201)
    const { price } = await res.json()
    expect(price.model_id).toBe('E2E_TEST_MODEL_A')
    expect(price.vendor).toBe('E2E_TEST_vendor')
    expect(price.input_unit_price).toBe(21)
    expect(price.output_unit_price).toBe(105)
    expect(price.cache_write_unit_price).toBe(26.25)
    expect(price.cache_read_unit_price).toBe(2.1)
    expect(price.currency).toBe('CNY')
    expect(price.valid_from).toBeNull() // 缺省 = 兜底价（全时段）
    expect(price.valid_to).toBeNull()
    expect(typeof price.id).toBe('string')
    expect(price.id.length).toBeGreaterThan(0)
    expect(typeof price.created_at).toBe('string')
    expect(typeof price.updated_at).toBe('string')
    aCatchallId = price.id

    // DB 交叉：行存在且窗口字段一致
    const row = dao().getPrice(price.id)!
    expect(row).not.toBeNull()
    expect(row.id).toBe(price.id)
    expect(row.input_unit_price).toBe(21)
    expect(row.currency).toBe('CNY')
    expect([row.valid_from, row.valid_to]).toEqual([null, null])

    const list = await listPrices()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(price.id)
  })

  it('POST 第二条兜底价 → 400 PRICE_CATCHALL_DUPLICATE（每模型至多一条兜底），DB 不增行', async () => {
    await expect400('POST', '/api/system/billing/prices', { ...VALID_A, vendor: 'E2E_TEST_vendor_2' }, 'PRICE_CATCHALL_DUPLICATE')
    expect(dao().getPrice(aCatchallId)!.vendor).toBe('E2E_TEST_vendor') // 未被覆盖
    expect(await listPrices()).toHaveLength(1)
  })

  it('POST 时间段价 → 201；响应窗口 = 本地零点 epoch（日期串进、毫秒出）', async () => {
    const res = await jsonReq('POST', '/api/system/billing/prices', {
      ...VALID_A, input_unit_price: 10, valid_from: '2026-09-10', valid_to: '2026-09-20',
    })
    expect(res.status).toBe(201)
    const { price } = await res.json()
    expect(price.valid_from).toBe(localMidnight('2026-09-10'))
    expect(price.valid_to).toBe(localMidnight('2026-09-20'))
    aWindowId = price.id
    // 兜底价与窗口价可共存（model_id 不再唯一）
    const list = await listPrices()
    expect(list).toHaveLength(2)
    expect(list.map(p => p.id)).toContain(aWindowId)
  })

  it('窗口违例全 400 带 code：重叠 / from>=to（含零宽与倒挂）；DB 不增行', async () => {
    const win = (f: string, t: string) => ({ ...VALID_A, model_id: 'E2E_TEST_MODEL_A', valid_from: f, valid_to: t })
    await expect400('POST', '/api/system/billing/prices', win('2026-09-15', '2026-09-25'), 'PRICE_WINDOW_OVERLAP') // 包含式重叠
    await expect400('POST', '/api/system/billing/prices', win('2026-09-20', '2026-09-20'), 'PRICE_WINDOW_ORDER') // 零宽
    await expect400('POST', '/api/system/billing/prices', win('2026-09-25', '2026-09-10'), 'PRICE_WINDOW_ORDER') // 倒挂
    expect(await listPrices()).toHaveLength(2)
  })

  it('半开区间：from == 既有 to（界点相邻）放行 → 201，DELETE → 200，二次 DELETE → 404', async () => {
    const res = await jsonReq('POST', '/api/system/billing/prices', {
      ...VALID_A, valid_from: '2026-09-20', valid_to: '2026-09-30',
    })
    expect(res.status).toBe(201) // [9/10,9/20) 与 [9/20,9/30) 不重叠
    const adjId = (await res.json()).price.id
    expect(await listPrices()).toHaveLength(3)

    const del = await app.request(`/api/system/billing/prices/${adjId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ success: true })
    expect(dao().getPrice(adjId)).toBeNull()
    const again = await app.request(`/api/system/billing/prices/${adjId}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
    expect((await again.json()).error.code).toBe('NOT_FOUND')
  })

  it('非法输入全部 400 且错误体含 code：单价负 / currency EUR / model_id 空 / vendor 空 / 单价 NaN 串 / 日期串非法', async () => {
    const bad: unknown[] = [
      { ...VALID_A, model_id: 'E2E_TEST_BAD_1', input_unit_price: -1 },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_2', output_unit_price: -0.01 },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_3', currency: 'EUR' },
      { ...VALID_A, model_id: '' },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_4', vendor: '' },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_5', cache_read_unit_price: 'abc' },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_6', valid_from: 'garbage' },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_7', valid_to: '2026-13-01' },
    ]
    for (const body of bad) {
      const res = await jsonReq('POST', '/api/system/billing/prices', body)
      expect(res.status, `expect 400 for ${JSON.stringify(body)}`).toBe(400)
      const err = await res.json()
      expect(err.error?.code, `error.code missing for ${JSON.stringify(body)}`).toBeTruthy()
    }
    expect(await listPrices()).toHaveLength(2) // 一条都没入库
  })

  it('model_id 保存前归一化：POST "E2E_TEST_NORM[1m]" 落库去尾缀；纯残缀 " ]" → 400 PRICE_MODEL_INVALID', async () => {
    const res = await jsonReq('POST', '/api/system/billing/prices', { ...VALID_A, model_id: 'E2E_TEST_NORM[1m]' })
    expect(res.status).toBe(201)
    const { price } = await res.json()
    expect(price.model_id).toBe('E2E_TEST_NORM')
    expect(dao().getPrice(price.id)!.model_id).toBe('E2E_TEST_NORM')
    // 归一后为空串 → 拒
    await expect400('POST', '/api/system/billing/prices', { ...VALID_A, model_id: ' ] ', vendor: 'E2E_TEST_vendor_n2' }, 'PRICE_MODEL_INVALID')
    expect(await listPrices()).toHaveLength(3)

    // 列表序：model_id ASC，同模型兜底价先、窗口按 valid_from 升（手写钉）
    const list = await listPrices()
    expect(list.map(p => p.id)).toEqual([aCatchallId, aWindowId, price.id])
  })

  it('PUT：404 未知 id / 400 空 body / 改价未传字段不动（DB 交叉）', async () => {
    const miss = await jsonReq('PUT', '/api/system/billing/prices/E2E_TEST_MISSING_ID', { input_unit_price: 1 })
    expect(miss.status).toBe(404)
    expect((await miss.json()).error.code).toBe('NOT_FOUND')
    await expect400('PUT', `/api/system/billing/prices/${aCatchallId}`, {}, 'INVALID_PARAM')

    const res = await jsonReq('PUT', `/api/system/billing/prices/${aCatchallId}`, { input_unit_price: 22, currency: 'USD' })
    expect(res.status).toBe(200)
    const { price } = await res.json()
    expect(price.input_unit_price).toBe(22)
    expect(price.currency).toBe('USD')
    expect(price.output_unit_price).toBe(105) // 未传的不动
    expect(price.valid_from).toBeNull()
    const dbRow = dao().getPrice(aCatchallId)!
    expect(dbRow.input_unit_price).toBe(22)
    expect(dbRow.currency).toBe('USD')
  })

  it('PUT 撞他人兜底价 → 400 PRICE_CATCHALL_DUPLICATE（旧 409 语义退役）；失败写不改 DB', async () => {
    const norm = dao().listPrices().find(p => p.model_id === 'E2E_TEST_NORM')!
    const clash = await jsonReq('PUT', `/api/system/billing/prices/${norm.id}`, { model_id: 'E2E_TEST_MODEL_A' })
    expect(clash.status).toBe(400)
    expect((await clash.json()).error.code).toBe('PRICE_CATCHALL_DUPLICATE')
    expect(dao().getPrice(norm.id)!.model_id).toBe('E2E_TEST_NORM')
  })

  it('PUT 窗口边界：日期串设界 → epoch；valid_from:null 拆界回兜底（缺省 = 不动）', async () => {
    const norm = dao().listPrices().find(p => p.model_id === 'E2E_TEST_NORM')!
    const setWin = await jsonReq('PUT', `/api/system/billing/prices/${norm.id}`, { valid_from: '2026-09-01' })
    expect(setWin.status).toBe(200)
    const { price } = await setWin.json()
    expect(price.valid_from).toBe(localMidnight('2026-09-01'))
    expect(price.valid_to).toBeNull() // 缺省字段保持不动（此行为 null 兜底拆界而来）

    const unbind = await jsonReq('PUT', `/api/system/billing/prices/${norm.id}`, { valid_from: null })
    expect(unbind.status).toBe(200)
    const back = (await unbind.json()).price
    expect([back.valid_from, back.valid_to]).toEqual([null, null])
    expect(dao().getPrice(norm.id)!.valid_from).toBeNull()
  })
})

describe('改价即回算（NEW-r2 语义翻转：账本不落钱，历史随规则重算）', () => {
  it('事实行配价立即出钱 → 改价即时换值 → 删价回落 NULL/unpriced', async () => {
    new TokenUsageDAO(getDb()).insertLlmCall({
      id: 'live-1', node_execution_id: null, execution_id: null, turn_index: 0, call_index: 0,
      message_id: null, model: 'E2E_TEST_LIVE', stop_reason: null, timestamp: 1_700_000_000_000,
      duration_ms: 100, ttft_ms: null, input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      org: 'default', workspace_id: 'ws-live', workflow_ref: null, node_id: null, session_id: null, instance_id: 'inst-live',
    })
    const created = await jsonReq('POST', '/api/system/billing/prices', {
      vendor: 'E2E_TEST_vendor', model_id: 'E2E_TEST_LIVE', input_unit_price: 1000, output_unit_price: 0,
      cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD',
    })
    expect(created.status).toBe(201)
    const pid = (await created.json()).price.id as string

    const priced = (await (await app.request('/api/system/billing/calls?model=E2E_TEST_LIVE')).json()).calls[0]
    expect(priced).toMatchObject({ id: 'live-1', cost_usd: 1, price_status: 'priced' }) // 1000×1000/1M

    const reprice = await jsonReq('PUT', `/api/system/billing/prices/${pid}`, { input_unit_price: 2000 })
    expect(reprice.status).toBe(200)
    const after = (await (await app.request('/api/system/billing/calls?model=E2E_TEST_LIVE')).json()).calls[0]
    expect(after).toMatchObject({ id: 'live-1', cost_usd: 2, price_status: 'priced' }) // 同一行立即回算

    const del = await app.request(`/api/system/billing/prices/${pid}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const reverted = (await (await app.request('/api/system/billing/calls?model=E2E_TEST_LIVE')).json()).calls[0]
    expect(reverted).toMatchObject({ id: 'live-1', cost_usd: null, price_status: 'unpriced' }) // 删价 = 账目回落 NULL（不焊 0）
    getDb().prepare("DELETE FROM llm_calls WHERE id = 'live-1'").run()
  })
})

describe('POST /api/system/billing/price-preview — 试算器', () => {
  // 注：生产码 price-sql.ts pricePreviewSql() 引用未定义的 q.cost_usd/q.vendor，
  // 本组当前必红（500 READ_FAILED）—— 按契约断言，不绕过；详见交付报告。
  const PREVIEW = {
    vendor: 'E2E_TEST_vendor', model_id: 'E2E_TEST_PREVIEW', input_unit_price: 2, output_unit_price: 4,
    cache_write_unit_price: 6, cache_read_unit_price: 8, currency: 'USD',
    valid_from: '2026-09-01', valid_to: '2026-10-01',
  }
  let previewPriceId = ''

  it('POST 窗口价行（试算靶）→ 201', async () => {
    const res = await jsonReq('POST', '/api/system/billing/prices', PREVIEW)
    expect(res.status).toBe(201)
    previewPriceId = (await res.json()).price.id
  })

  it('窗口内日期 → priced：四类 token×单价/1M = 6 USD，CNY 展示 = ×7；price_id/vendor 命中', async () => {
    const res = await jsonReq('POST', '/api/system/billing/price-preview', {
      model: 'E2E_TEST_PREVIEW', date: '2026-09-15',
      input_tokens: 500000, output_tokens: 250000, cache_creation_tokens: 500000, cache_read_tokens: 125000,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // (500000×2 + 250000×4 + 500000×6 + 125000×8)/1M = 6
    expect(body).toMatchObject({
      price_status: 'priced',
      cost_usd: expect.closeTo(6, 10), cost_native: expect.closeTo(6, 10), cost_currency: 'USD',
      vendor: 'E2E_TEST_vendor', price_id: previewPriceId,
      cost_display: expect.closeTo(42, 10), currency_rate: 7, display_currency: 'CNY',
    })
  })

  it('窗口外日期 → unpriced 全 NULL；模型名带尾缀归一后照常命中；timestamp 与 date 等价', async () => {
    const miss = await jsonReq('POST', '/api/system/billing/price-preview', {
      model: 'E2E_TEST_PREVIEW', date: '2026-11-01', input_tokens: 500000,
    })
    expect(miss.status).toBe(200)
    expect(await miss.json()).toMatchObject({
      price_status: 'unpriced', cost_usd: null, cost_native: null, cost_currency: null, price_id: null,
    })
    const norm = await jsonReq('POST', '/api/system/billing/price-preview', {
      model: 'E2E_TEST_PREVIEW[1m]', timestamp: localMidnight('2026-09-15'), input_tokens: 500000, output_tokens: 250000,
    })
    expect(norm.status).toBe(200)
    const nb = await norm.json()
    expect(nb.price_status).toBe('priced')
    expect(nb.cost_usd).toBeCloseTo(2, 10) // 500000×2/1M = 1；250000×4/1M = 1
  })

  it('参数缺失/非法 → 400：date/timestamp 都不给、日期串非法', async () => {
    await expect400('POST', '/api/system/billing/price-preview', { model: 'E2E_TEST_PREVIEW' }, 'INVALID_PARAM')
    await expect400('POST', '/api/system/billing/price-preview', { model: 'E2E_TEST_PREVIEW', date: '2026-13-01' }, 'VALIDATION_FAILED')
  })
})

describe('/api/system/billing/settings GET/PUT', () => {
  it('PUT {usd_to_cny:"6.5",display_currency:"USD"} → 200，GET 立即回新值；DB 双键各仅一行', async () => {
    const res = await jsonReq('PUT', '/api/system/billing/settings', { usd_to_cny: '6.5', display_currency: 'USD' })
    expect(res.status).toBe(200)
    const get = await app.request('/api/system/billing/settings')
    expect(await get.json()).toEqual({ usd_to_cny: '6.5', display_currency: 'USD' })
    const raw = getDb().prepare("SELECT key, value FROM billing_setting ORDER BY key").all() as { key: string; value: string }[]
    expect(raw).toEqual([
      { key: 'display_currency', value: 'USD' },
      { key: 'usd_to_cny', value: '6.5' },
    ])
  })

  it('非法汇率与币种 → 4xx 带 code；DB 值不被污染', async () => {
    const bad: unknown[] = [
      { usd_to_cny: '0' },
      { usd_to_cny: '-1' },
      { usd_to_cny: 'abc' },
      { usd_to_cny: 0 },
      { display_currency: 'EUR' },
      {},
    ]
    for (const body of bad) {
      const res = await jsonReq('PUT', '/api/system/billing/settings', body)
      expect(res.status, `expect 4xx for ${JSON.stringify(body)}`).toBe(400)
      expect((await res.json()).error?.code).toBeTruthy()
    }
    expect(await (await app.request('/api/system/billing/settings')).json()).toEqual({ usd_to_cny: '6.5', display_currency: 'USD' })
  })

  it('数值型汇率亦可（6 → "6"）；部分更新只动一个键', async () => {
    const res = await jsonReq('PUT', '/api/system/billing/settings', { usd_to_cny: 6 })
    expect(res.status).toBe(200)
    expect(await (await app.request('/api/system/billing/settings')).json()).toEqual({ usd_to_cny: '6', display_currency: 'USD' })
    const res2 = await jsonReq('PUT', '/api/system/billing/settings', { display_currency: 'CNY' })
    expect(res2.status).toBe(200)
    expect(await (await app.request('/api/system/billing/settings')).json()).toEqual({ usd_to_cny: '6', display_currency: 'CNY' })
  })
})

describe('清理（Verification Method 步骤 7）', () => {
  it('删除全部 E2E_TEST_ 价格行 + 恢复 settings 默认，复核行数为初始值', async () => {
    getDb().prepare("DELETE FROM billing_price_config WHERE model_id LIKE 'E2E_TEST_%'").run()
    getDb().prepare("DELETE FROM llm_calls WHERE model LIKE 'E2E_TEST_%'").run()
    expect(dao().listPrices()).toHaveLength(0)
    // 恢复默认（写回默认等价物 = 删除行，回落 DAO 兜底）
    getDb().prepare('DELETE FROM billing_setting').run()
    expect(await listPrices()).toHaveLength(0)
    expect(await (await app.request('/api/system/billing/settings')).json()).toEqual({ usd_to_cny: '7.0', display_currency: 'CNY' })
  })
})
