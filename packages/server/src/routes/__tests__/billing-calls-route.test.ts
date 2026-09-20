// 06 · 计费流水 API 集成测试（billing-core-1 ticket 06）
// Seam: GET /api/system/billing/calls —— 分页流水 + model/时间/price_status/workspace 筛选。
// Hono app.request() 进程内真实路由栈 + 真实 SQLite；行经 TokenUsageDAO.insertLlmCall
// （票 04 写入口）落库；筛选结果与 SQL 直查交叉；期望值手写。数据 E2E_TEST_ 前缀，尾部清理。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../../db/connection'
import { createSystemRoutes } from '../system'
import { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { LlmCallRow } from '../../db/types'

const system = createSystemRoutes()
const app = new Hono().route('/api/system', system)

let dbPath: string

const CALLS_URL = '/api/system/billing/calls'

/** 手写四行夹具：两个模型、两种定价状态、两个工作区、不同时间。 */
const T = { base: 1_700_000_000_000, c1: 1_700_000_001_000, c2: 1_700_000_002_000, c3: 1_700_000_003_000 }

function row(id: string, model: string, ts: number, ws: string, cost: { usd: number | null; native: number | null; cur: string | null; status: 'priced' | 'unpriced' }): LlmCallRow {
  return {
    id, node_execution_id: 'e1-n1', execution_id: 'e-1', turn_index: 1, call_index: 0,
    message_id: null, model, stop_reason: null, timestamp: ts, duration_ms: 100, ttft_ms: null,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
    cost_usd: cost.usd, cost_native: cost.native, cost_currency: cost.cur, price_status: cost.status,
    org: 'default', workspace_id: ws, workflow_ref: 'wf.yaml', node_id: 'n1', session_id: 's-1', instance_id: 'inst-1',
  }
}

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-calls-${process.pid}-${Date.now()}.db`)
  initDb(dbPath)
  const db = getDb()
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS1','/tmp/1','default',?,?)").run(t, t)
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-2','WS2','/tmp/2','default',?,?)").run(t, t)
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e-1','ws-1','0','wf.yaml','WF','completed',?,?,?,?,?)`).run(t, t, 'default', t, t)
  db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('e1-n1','e-1','n1','agent','completed',0,1,?,?)").run(t, t)
  const dao = new TokenUsageDAO(db)
  // c1: ws-1 A priced-USD | c2: ws-1 A unpriced | c3: ws-1 B priced-CNY | c4: ws-2 B priced-USD（时间乱序插入验证倒序）
  dao.insertLlmCall(row('c4', 'E2E_TEST_B', T.base, 'ws-2', { usd: 1.1, native: 1.1, cur: 'USD', status: 'priced' }))
  dao.insertLlmCall(row('c1', 'E2E_TEST_A', T.c1, 'ws-1', { usd: 22.05, native: 22.05, cur: 'USD', status: 'priced' }))
  dao.insertLlmCall(row('c3', 'E2E_TEST_B', T.c3, 'ws-1', { usd: 22, native: 154, cur: 'CNY', status: 'priced' }))
  dao.insertLlmCall(row('c2', 'E2E_TEST_A', T.c2, 'ws-1', { usd: null, native: null, cur: null, status: 'unpriced' }))
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE id LIKE 'c%' AND model LIKE 'E2E_TEST_%'").run()
  const left = (getDb().prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE model LIKE 'E2E_TEST_%'").get() as { n: number }).n
  expect(left).toBe(0) // 清理复核
  closeDb()
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

async function get(params = ''): Promise<{ status: number; body: Record<string, never> }> {
  const res = await app.request(`${CALLS_URL}${params}`)
  return { status: res.status, body: await res.json() }
}

/** SQL 直查交叉（独立真相源）。 */
function sqlIds(where: string, args: unknown[] = []): string[] {
  return (getDb().prepare(`SELECT id FROM llm_calls WHERE model LIKE 'E2E_TEST_%' ${where} ORDER BY timestamp DESC`).all(...args) as { id: string }[]).map(r => r.id)
}

describe('GET /api/system/billing/calls — 默认流水', () => {
  it('按 timestamp 倒序、字段齐全、分页默认 50、含 models 候选与 total', async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.total).toBe(4)
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(50)
    expect((body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c3', 'c2', 'c1', 'c4']) // 手算倒序 3000>2000>1000>0
    expect(body.models).toEqual(['E2E_TEST_A', 'E2E_TEST_B'])
    const c3 = (body.calls as Array<Record<string, unknown>>)[0]
    // AC1：四类 token + 三快照列 + 归属维度字段齐
    expect(c3).toMatchObject({
      id: 'c3', model: 'E2E_TEST_B', timestamp: T.c3,
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
      cost_usd: 22, cost_native: 154, cost_currency: 'CNY', price_status: 'priced',
      workspace_id: 'ws-1', workflow_ref: 'wf.yaml', execution_id: 'e-1', node_id: 'n1', session_id: 's-1',
    })
    const c2 = (body.calls as Array<Record<string, unknown>>)[1]
    expect(c2).toMatchObject({ id: 'c2', cost_usd: null, cost_native: null, cost_currency: null, price_status: 'unpriced' })
  })

  it('page_size=2 翻页：两页并集 = 全量且顺序稳定', async () => {
    const p1 = await get('?page=1&page_size=2')
    const p2 = await get('?page=2&page_size=2')
    expect((p1.body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c3', 'c2'])
    expect((p2.body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c1', 'c4'])
    expect(p1.body.total).toBe(4)
    expect(p2.body.pageSize).toBe(2)
  })
})

describe('筛选组合 = SQL 直查（AC2）', () => {
  it('price_status=unpriced 只回 unpriced', async () => {
    const { body } = await get('?price_status=unpriced')
    expect((body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(sqlIds("AND price_status = 'unpriced'"))
    expect(body.total).toBe(1)
  })

  it('model 精确筛选', async () => {
    const { body } = await get('?model=E2E_TEST_A')
    expect((body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c2', 'c1'])
    expect((body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(sqlIds("AND model = 'E2E_TEST_A'"))
  })

  it('时间区间 from/to（含界）', async () => {
    const { body } = await get(`?from=${T.c2}&to=${T.c3}`)
    expect((body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(sqlIds('AND timestamp >= ? AND timestamp <= ?', [T.c2, T.c3]))
    expect((body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c3', 'c2'])
  })

  it('workspace_id 筛选 + 组合（model+status）', async () => {
    const ws = await get('?workspace_id=ws-2')
    expect((ws.body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c4'])
    const combo = await get('?model=E2E_TEST_B&price_status=priced')
    expect((combo.body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(sqlIds("AND model = 'E2E_TEST_B' AND price_status = 'priced'"))
    expect((combo.body.calls as Array<{ id: string }>).map(c => c.id)).toEqual(['c3', 'c4'])
  })
})

describe('非法参数 400', () => {
  it('price_status 枚举外 / page_size 越界 / from 非数值 → 400 带 code', async () => {
    for (const q of ['?price_status=whatever', '?page_size=9999', '?from=abc', '?page=0']) {
      const { status, body } = await get(q)
      expect(status, q).toBe(400)
      expect((body.error as { code?: string })?.code).toBeTruthy()
    }
  })
})
