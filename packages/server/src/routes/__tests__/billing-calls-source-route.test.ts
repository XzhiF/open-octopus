// 05 · 来源维度 API 集成测试（billing-coverage-2 ticket 05，billing NEW-r2 改版）
// Seam: GET /api/system/billing/calls —— source_path 筛选参数 + source_subtotals 小计块。
// NEW-r2：行只存事实，费用查询时按价行派生（视图 llm_calls_costed 无 price_status 列，
// 「priced」= cost_usd IS NOT NULL）；unpriced 计行不计费（KD4）；NULL 老行按 unknown 可筛（AC3）。
// 数据 E2E_TEST_SRC_ 前缀，尾部清理。
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
import type { LlmCallSourcePath } from '@octopus/shared'

const system = createSystemRoutes()
const app = new Hono().route('/api/system', system)

let dbPath: string
const CALLS_URL = '/api/system/billing/calls'
const T0 = 1_700_000_100_000

/** 手写夹具：六来源 + unknown 各 ≥1 行。费用不再写进行 —— 由价行派生。 */
function row(id: string, over: Partial<LlmCallRow> & { source_path?: LlmCallSourcePath | null }): LlmCallRow {
  return {
    id, node_execution_id: 'e5-n1', execution_id: 'e-5', turn_index: 1, call_index: 0,
    message_id: null, model: 'E2E_TEST_SRC_M', stop_reason: null, timestamp: T0, duration_ms: 100, ttft_ms: null,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
    org: 'default', workspace_id: 'ws-5', workflow_ref: 'wf.yaml', node_id: 'n1', session_id: 's-5', instance_id: 'inst-5',
    ...over,
  }
}

// M 价行 = catch-all USD 只计 input（单价 500/1M）→ cost_usd = input_tokens × 0.0005，
// 即「想要 0.5 美元就塞 1000 input token」。MUP 模型不配价 → 派生恒 NULL。
const FIXTURES: Array<[string, LlmCallSourcePath | null, number, boolean]> = [
  ['x-wf1', 'workflow', 1000, false],
  ['x-wf2', 'workflow', 500, false],
  ['x-wf3', 'workflow', 600, true],          // unpriced：计行不计费
  ['x-ix1', 'interaction', 2000, false],
  ['x-ha1', 'harness', 250, false],
  ['x-cc1', 'clone_chat', 4000, false],
  ['x-gc1', 'global_chat', 300, true],       // 全未定价来源 → 小计 cost NULL（不焊 0）
  ['x-sc1', 'session_compress', 125, false],
  ['x-un1', 'unknown', 1000, false],
  ['x-nu1', null, 800, true],                // 回填前 NULL 老行：按 unknown 筛出（AC3）
]

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-source-${process.pid}-${Date.now()}.db`)
  initDb(dbPath)
  const db = getDb()
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-5','WS5','/tmp/5','default',?,?)").run(t, t)
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e-5','ws-5','0','wf.yaml','WF','completed',?,?,?,?,?)`).run(t, t, 'default', t, t)
  db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('e5-n1','e-5','n1','agent','completed',0,1,?,?)").run(t, t)
  new BillingDAO(db).createPrice({ id: 'p-src-m', vendor: 'E2E_TEST_SRC_V', model_id: 'E2E_TEST_SRC_M', input_unit_price: 500, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: 'USD' })
  const dao = new TokenUsageDAO(db)
  FIXTURES.forEach(([id, source, inTok, mup], i) => {
    const r = row(id, {
      model: mup ? 'E2E_TEST_SRC_MUP' : 'E2E_TEST_SRC_M',
      source_path: source, input_tokens: inTok, timestamp: T0 + i,
    })
    if (source === null) delete (r as { source_path?: string }).source_path // 模拟老行不带列值
    dao.insertLlmCall(r)
  })
})

afterAll(() => {
  getDb().prepare("DELETE FROM llm_calls WHERE model LIKE 'E2E_TEST_SRC_%'").run()
  getDb().prepare("DELETE FROM billing_price_config WHERE model_id LIKE 'E2E_TEST_SRC_%'").run()
  expect((getDb().prepare("SELECT COUNT(*) n FROM llm_calls WHERE model LIKE 'E2E_TEST_SRC_%'").get() as { n: number }).n).toBe(0)
  closeDb()
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f)
})

async function get(params = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`${CALLS_URL}${params}`)
  return { status: res.status, body: await res.json() }
}

/** SQL 直查交叉（独立真相源；事实列走 llm_calls，派生列走视图）。 */
function sqlIds(source: LlmCallSourcePath): string[] {
  const w = source === 'unknown' ? "(source_path = 'unknown' OR source_path IS NULL)" : 'source_path = ?'
  const args = source === 'unknown' ? [] : [source]
  return (getDb().prepare(
    `SELECT id FROM llm_calls WHERE model LIKE 'E2E_TEST_SRC_%' AND ${w} ORDER BY timestamp DESC`,
  ).all(...args) as { id: string }[]).map(r => r.id)
}

describe('source_path 筛选 = SQL 直查（AC1/AC3）', () => {
  it('逐来源筛选行集一致', async () => {
    for (const source of ['workflow', 'interaction', 'harness', 'clone_chat', 'global_chat', 'session_compress', 'unknown'] as const) {
      const { status, body } = await get(`?source_path=${source}`)
      expect(status, source).toBe(200)
      expect((body.calls as Array<{ id: string }>).map(c => c.id), source).toEqual(sqlIds(source))
    }
  })

  it('unknown 同时兜出 NULL 老行；行 payload 带 source_path', async () => {
    const { body } = await get('?source_path=unknown')
    const calls = body.calls as Array<{ id: string; source_path: string | null }>
    expect(calls.map(c => c.id).sort()).toEqual(['x-nu1', 'x-un1'])
    expect(calls.find(c => c.id === 'x-un1')!.source_path).toBe('unknown')
    expect(calls.find(c => c.id === 'x-nu1')!.source_path).toBeNull()
  })

  it('与其他筛选组合（source + 派生 price_status）', async () => {
    const { body } = await get('?source_path=workflow&price_status=priced')
    expect((body.calls as Array<{ id: string }>).map(c => c.id).sort()).toEqual(['x-wf1', 'x-wf2'])
  })

  it('枚举外来源 → 400', async () => {
    const { status, body } = await get('?source_path=bogus')
    expect(status).toBe(400)
    expect((body.error as { code?: string })?.code).toBeTruthy()
  })
})

describe('source_subtotals 小计块（AC2 / KD26 同筛选口径；费用 = 派生）', () => {
  it('各来源：条数 = SQL COUNT，费用 = 视图 SUM(cost_usd)；unpriced 计行不计费；全未定价 → NULL 不焊 0', async () => {
    const { body } = await get()
    const subs = body.source_subtotals as Array<{ source: string; count: number; priced_count: number; cost_usd: number | null }>
    const bySource = Object.fromEntries(subs.map(s => [s.source, s]))
    for (const src of ['workflow', 'interaction', 'harness', 'clone_chat', 'global_chat', 'session_compress', 'unknown']) {
      const sql = getDb().prepare(
        `SELECT COUNT(*) count,
                SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) priced_count,
                SUM(cost_usd) cost_usd
         FROM llm_calls_costed WHERE model LIKE 'E2E_TEST_SRC_%' AND ${
           src === 'unknown' ? "(source_path = 'unknown' OR source_path IS NULL)" : "source_path = ?"
         }`,
      ).get(...(src === 'unknown' ? [] : [src])) as { count: number; priced_count: number; cost_usd: number | null }
      expect(bySource[src], src).toEqual({ source: src, ...sql })
    }
    // 手算钉值（不只靠 SQL 自证；M 价 = in×500/1M）：workflow = 0.5+0.25=0.75（3 行含 1 未定价）；global_chat 全未定价 → NULL
    expect(bySource.workflow).toEqual({ source: 'workflow', count: 3, priced_count: 2, cost_usd: expect.closeTo(0.75, 12) })
    expect(bySource.global_chat).toEqual({ source: 'global_chat', count: 1, priced_count: 0, cost_usd: null })
    expect(bySource.unknown).toEqual({ source: 'unknown', count: 2, priced_count: 1, cost_usd: 0.5 })
  })

  it('小计随筛选条件走（当前筛选下合计，非全量）', async () => {
    const { body } = await get('?source_path=workflow')
    const subs = body.source_subtotals as Array<{ source: string; count: number }>
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ source: 'workflow', count: 3 })
  })
})
