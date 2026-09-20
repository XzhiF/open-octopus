// 03 · 计费配置 API 集成测试（billing-core-1 ticket 03）
// Seam: /api/system/billing/prices CRUD + /api/system/billing/settings GET/PUT。
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

const VALID_A = {
  vendor: 'E2E_TEST_vendor',
  model_id: 'E2E_TEST_MODEL_A',
  input_unit_price: 21,
  output_unit_price: 105,
  cache_write_unit_price: 26.25,
  cache_read_unit_price: 2.1,
  currency: 'CNY',
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

describe('/api/system/billing/prices CRUD（写入必验副作用 API↔DB）', () => {
  it('POST 合法 → 201，响应业务字段逐项 = 手写期望；DB SELECT 比对一致', async () => {
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
    expect(typeof price.id).toBe('string')
    expect(price.id.length).toBeGreaterThan(0)
    expect(typeof price.created_at).toBe('string')
    expect(typeof price.updated_at).toBe('string')

    // DB 交叉：行存在且字段一致
    const row = dao().getPriceByModel('E2E_TEST_MODEL_A')!
    expect(row).not.toBeNull()
    expect(row.id).toBe(price.id)
    expect(row.input_unit_price).toBe(21)
    expect(row.currency).toBe('CNY')

    // GET 列表回含
    const list = await (await app.request('/api/system/billing/prices')).json()
    expect(list.prices).toHaveLength(1)
    expect(list.prices[0].id).toBe(price.id)
  })

  it('POST 重复 model_id → 409 + code，DB 不增行', async () => {
    const res = await jsonReq('POST', '/api/system/billing/prices', { ...VALID_A, vendor: 'E2E_TEST_vendor_2' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('DUPLICATE_MODEL_ID')
    expect(typeof body.error.message).toBe('string')
    expect(dao().getPriceByModel('E2E_TEST_MODEL_A')!.vendor).toBe('E2E_TEST_vendor') // 未被覆盖
    expect((await (await app.request('/api/system/billing/prices')).json()).prices).toHaveLength(1)
  })

  it('非法输入全部 4xx 且错误体含 code：单价 -1 / 单价 NaN 串 / currency EUR / model_id 空 / vendor 空', async () => {
    const bad = [
      { ...VALID_A, model_id: 'E2E_TEST_BAD_1', input_unit_price: -1 },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_2', output_unit_price: -0.01 },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_3', currency: 'EUR' },
      { ...VALID_A, model_id: '' },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_4', vendor: '' },
      { ...VALID_A, model_id: 'E2E_TEST_BAD_5', cache_read_unit_price: 'abc' as unknown as number },
    ]
    for (const body of bad) {
      const res = await jsonReq('POST', '/api/system/billing/prices', { ...body, model_id: body.model_id || '' })
      expect(res.status, `expect 4xx for ${JSON.stringify(body)}`).toBe(400)
      const err = await res.json()
      expect(err.error?.code, `error.code missing for ${JSON.stringify(body)}`).toBeTruthy()
    }
    // 一条都没入库
    expect((await (await app.request('/api/system/billing/prices')).json()).prices).toHaveLength(1)
  })

  it('PUT 改价 → 200，响应与 DB 同步随动；未传字段不动', async () => {
    const id = dao().getPriceByModel('E2E_TEST_MODEL_A')!.id
    const res = await jsonReq('PUT', `/api/system/billing/prices/${id}`, { input_unit_price: 9.9, currency: 'USD' })
    expect(res.status).toBe(200)
    const { price } = await res.json()
    expect(price.input_unit_price).toBe(9.9)
    expect(price.currency).toBe('USD')
    expect(price.output_unit_price).toBe(105) // 未传的不动
    const dbRow = dao().getPrice(id)!
    expect(dbRow.input_unit_price).toBe(9.9)
    expect(dbRow.currency).toBe('USD')
  })

  it('PUT 不存在 id → 404 NOT_FOUND；PUT 撞他人 model_id → 409', async () => {
    await jsonReq('POST', '/api/system/billing/prices', { ...VALID_A, model_id: 'E2E_TEST_MODEL_B', vendor: 'E2E_TEST_vendor_b' })
    const rowB = dao().getPriceByModel('E2E_TEST_MODEL_B')!
    const miss = await jsonReq('PUT', '/api/system/billing/prices/E2E_TEST_MISSING_ID', { input_unit_price: 1 })
    expect(miss.status).toBe(404)
    expect((await miss.json()).error.code).toBe('NOT_FOUND')

    const clash = await jsonReq('PUT', `/api/system/billing/prices/${rowB.id}`, { model_id: 'E2E_TEST_MODEL_A' })
    expect(clash.status).toBe(409)
    expect((await clash.json()).error.code).toBe('DUPLICATE_MODEL_ID')
    // 失败写不改 DB
    expect(dao().getPrice(rowB.id)!.model_id).toBe('E2E_TEST_MODEL_B')
  })

  it('DELETE → 200 且行从 DB 消失；二次 DELETE → 404', async () => {
    const id = dao().getPriceByModel('E2E_TEST_MODEL_B')!.id
    const res = await app.request(`/api/system/billing/prices/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(dao().getPrice(id)).toBeNull()

    const again = await app.request(`/api/system/billing/prices/${id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
    expect((await again.json()).error.code).toBe('NOT_FOUND')
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
    const a = dao().getPriceByModel('E2E_TEST_MODEL_A')
    expect(a).toBeNull()
    if (a) dao().deletePrice(a.id)
    // 恢复默认（写回默认等价物 = 删除行，回落 DAO 兜底）
    getDb().prepare('DELETE FROM billing_setting').run()
    const list = await (await app.request('/api/system/billing/prices')).json()
    expect(list.prices).toHaveLength(0)
    expect(await (await app.request('/api/system/billing/settings')).json()).toEqual({ usd_to_cny: '7.0', display_currency: 'CNY' })
  })
})
