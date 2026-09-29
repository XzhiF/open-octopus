// P1 B4 票2B-1：LEDGER_SQL 金表两侧（SQL 侧跑 llm_calls_costed 视图 / ntu）已迁 PG ——
// fixture 落 PG 随机库（harness-dao 姿势）。布尔比较列按雷区清单加 ::int 对齐旧 0/1 契约，
// COUNT/SUM(int) 的 bigint-string 出口经 num() 归一（= DAO 出口同投影）。
// JS 镜像侧（shared/ledger）一字未动 —— 金表语义（两侧逐位相等）保持。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { TokenUsageDAO, toLedgerRows } from "../db/dao/token-usage-dao"
import {
  LEDGER_SQL, ledgerTotals, costSummary, cacheHitRateOf, addTokenUsage, llmUsageAggregates,
  emptyTokenUsage, totalTokens, type LedgerRow,
} from "@octopus/shared"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

/**
 * C3 金表测试（验收②，NEW-r2 版）：同一份账数据，SQL 公式（LEDGER_SQL 管 tokens/hitRate，
 * 钱的 SUM/COUNT 跑在 llm_calls_costed 派生视图上）与 JS 镜像函数（shared/ledger）必须逐位相等。
 * 两定义任何一侧漂移,这里立刻红。
 *
 * NEW-r2 变化：cost 不再是 ntu 存储列 —— 每行账的钱来自「事实行 × 兜底价」派生。
 * fixture 用逐模型单价构造出与旧 costUsd 期望相同的数字（120/60 USD per 1M input），
 * f3/f4 无价行 → 派生 NULL（三态里的 unpriced 分支）。
 */
let pg: PgFixture
const P = "e-1-node-a" // node_execution_id

// 混合数据集：有价/无价/全0输入/带cache —— 覆盖三态全部分支
const FIXTURES: Array<LedgerRow & { id: string; model: string }> = [
  { id: "f1", model: "m-f1", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheCreationTokens: 500, costUsd: 0.12 },
  { id: "f2", model: "m-f2", inputTokens: 500, outputTokens: 100, cacheReadTokens: 3000, cacheCreationTokens: 100, costUsd: 0.03 },
  { id: "f3", model: "m-f3", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
  { id: "f4", model: "m-f4", inputTokens: 0, outputTokens: 77, cacheReadTokens: 0, cacheCreationTokens: 9, costUsd: null },
]

const now = () => new Date().toISOString()
const T0 = 1_700_000_000_000

const num = (v: unknown): number => Number(v)

beforeAll(async () => {
  pg = await setupPgSchema()
  const t = now()
  await pg.sql.unsafe("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/x','o',$1,$2)", [t, t])
  await pg.sql.unsafe(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e-1','ws-1','0','t.yaml','T','completed',$1,$2,'o',$3,$4)`, [t, t, t, t])
  await pg.sql.unsafe(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES ($1, 'e-1', 'node-a', 'agent', 'completed', 0, 1, $2, $3)`, [P, t, t])
  for (const f of FIXTURES) {
    await pg.sql.unsafe(`INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'node', $8)`,
      [f.id, P, f.model, f.inputTokens, f.outputTokens, f.cacheReadTokens, f.cacheCreationTokens, t])
    // 与 ntu 累加行一一对应的 per-call 事实行(钱由视图按价行派生)
    await pg.sql.unsafe(`INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index,
        model, timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, workspace_id, source_path)
      VALUES ($1, $2, 'e-1', 1, 0, $3, $4, 1, $5, $6, $7, $8, 'ws-1', 'workflow')`,
      [f.id, P, f.model, T0, f.inputTokens, f.outputTokens, f.cacheReadTokens, f.cacheCreationTokens])
  }
  // 兜底价：f1 单价 120/Mtok(input) → 1000×120/1e6 = 0.12；f2 → 500×60/1e6 = 0.03；f3/f4 无价
  const price = (id: string, model: string, unit: number) => pg.sql.unsafe(
    `INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price,
      output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
     VALUES ($1, 'v', $2, $3, 0, 0, 0, 'USD', NULL, NULL, $4, $5)`, [id, model, unit, t, t])
  await price("p-f1", "m-f1", 120)
  await price("p-f2", "m-f2", 60)
})
afterAll(async () => {
  await pg?.close()
})

async function sqlTokens(where: string) {
  const rows = await pg.sql.unsafe(`
    SELECT
      COALESCE(${LEDGER_SQL.sumTokens('ntu.')}, 0) as tokens,
      ${LEDGER_SQL.cacheHitRate('ntu.')} as hit
    FROM node_token_usages ntu WHERE ${where}
  `) as unknown as Array<{ tokens: string | number; hit: string | number | null }>
  const r = rows[0]!
  return { tokens: num(r.tokens), hit: r.hit === null ? null : num(r.hit) }
}

async function sqlCost(ids: string[]) {
  const cond = ids.length > 0 ? `id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})` : "0 = 1"
  const rows = await pg.sql.unsafe(`
    SELECT
      CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS cost_usd,
      (COUNT(*) = COUNT(cost_usd))::int AS cost_complete
    FROM llm_calls_costed WHERE ${cond}
  `, ids) as unknown as Array<{ cost_usd: number | null; cost_complete: number }>
  return rows[0]!
}

const allIds = FIXTURES.map(f => f.id)

function jsTotals(rows: LedgerRow[]) {
  const t = ledgerTotals(rows)
  return { tokens: t.tokens, cost_usd: t.cost.usd, cost_complete: t.cost.complete ? 1 : 0, hit: t.cacheHitRate }
}

describePg('LEDGER_SQL ≡ JS 镜像（金表，NEW-r2：钱 = 派生视图）', () => {
  it('全量组：tokens/cost 三态/hitRate 逐位相等', async () => {
    const sql = { ...(await sqlTokens(`ntu.node_execution_id = '${P}'`)), ...(await sqlCost(allIds)) }
    const js = jsTotals(FIXTURES)
    expect(sql.tokens).toBe(js.tokens)
    expect(sql.cost_usd).toBeCloseTo(js.cost_usd as number, 12)
    expect(sql.cost_complete).toBe(js.cost_complete) // 有 NULL 行 → 都不 complete
    expect(sql.hit).toBeCloseTo(js.hit as number, 12)
  })

  it('全有价子组：complete 两侧同步为 true', async () => {
    const sub = FIXTURES.filter(f => ['f1', 'f2'].includes(f.id))
    const sql = { ...(await sqlTokens(`ntu.id IN ('f1','f2')`)), ...(await sqlCost(['f1', 'f2'])) }
    const js = jsTotals(sub)
    expect(sql.cost_complete).toBe(1)
    expect(js.cost_complete).toBe(1)
    expect(sql.cost_usd).toBeCloseTo(js.cost_usd as number, 12)
    expect(sql.tokens).toBe(js.tokens)
    expect(sql.hit).toBeCloseTo(js.hit as number, 12)
  })

  it('全无价子组：两侧都 usd=null', async () => {
    const sql = { ...(await sqlTokens(`ntu.id IN ('f3','f4')`)), ...(await sqlCost(['f3', 'f4'])) }
    const js = jsTotals(FIXTURES.filter(f => ['f3', 'f4'].includes(f.id)))
    expect(sql.cost_usd).toBeNull()
    expect(js.cost_usd).toBeNull()
    expect(sql.cost_complete).toBe(js.cost_complete)
  })

  it('空组：tokens 0 / usd null / vacuous complete —— 两侧一致', async () => {
    const sql = { ...(await sqlTokens("ntu.id = 'nope'")), ...(await sqlCost([])) }
    expect(sql.tokens).toBe(0)
    expect(sql.cost_usd).toBeNull()
    expect(sql.cost_complete).toBe(1)
    expect(sql.hit).toBeNull()
    const empty = ledgerTotals([])
    expect(empty.tokens).toBe(0)
    expect(empty.cost).toEqual({ usd: null, complete: true })
    expect(empty.cacheHitRate).toBeNull()
  })

  it('纯输入为零组（f4 单独）：hitRate 两侧都 null（不造假 0%）', async () => {
    expect((await sqlTokens("ntu.id = 'f4'")).hit).toBeNull()
    expect(cacheHitRateOf(FIXTURES[3])).toBeNull()
  })

  it('totalTokens/addTokenUsage 与 sumTokens 片段在 fixture 累加上一致', async () => {
    const merged = FIXTURES.reduce((acc, f) => addTokenUsage(acc, f), emptyTokenUsage())
    expect(totalTokens(merged)).toBe(FIXTURES.reduce((a, f) => a + totalTokens(f), 0))
    expect((await sqlTokens(`ntu.node_execution_id = '${P}'`)).tokens).toBe(totalTokens(merged))
  })

  it('costSummary 的已知和语义 == 视图 SUM（部分定价）', async () => {
    const costs = FIXTURES.map(f => f.costUsd)
    expect(costSummary(costs).usd).toBeCloseTo((await sqlCost(allIds)).cost_usd as number, 12)
  })

  // v49: aggregateLlmCallsBy 是新增的 GROUP BY 级 SQL 聚合（看板逐任务花费），
  // 金表义务同样成立 —— 它与 JS 侧（llmUsageAggregates / ledgerTotals）必须逐位相等。
  it('aggregateLlmCallsBy(execution_id) ≡ JS ledgerTotals（含三态与 hitRate）', async () => {
    const dao = new TokenUsageDAO(pg.sql)
    const got = (await dao.aggregateLlmCallsBy('execution_id', ['e-1'])).get('e-1')!
    const js = ledgerTotals(FIXTURES)
    expect(got.totalCalls).toBe(FIXTURES.length)
    expect(got.usage).toEqual(FIXTURES.reduce((acc, f) => addTokenUsage(acc, f), emptyTokenUsage()))
    expect(got.totals.tokens).toBe(js.tokens)
    expect(got.totals.cost.usd).toBeCloseTo(js.cost.usd as number, 12)
    expect(got.totals.cost.complete).toBe(js.cost.complete)
    expect(got.totals.cacheHitRate).toBeCloseTo(js.cacheHitRate as number, 12)
  })

  it('aggregateLlmCallsBy(session_id) ≡ llmUsageAggregates（会话口径同一批行）', async () => {
    await pg.sql`UPDATE llm_calls SET session_id = 's-mirror'`
    const dao = new TokenUsageDAO(pg.sql)
    const got = (await dao.aggregateLlmCallsBy('session_id', ['s-mirror'])).get('s-mirror')!
    const js = llmUsageAggregates(toLedgerRows(await dao.findLlmCallsBySession('s-mirror')))
    expect(got.totals).toEqual(js.totals)
    expect(got.usage).toEqual(js.usage)
    expect(got.totalCalls).toBe(js.totalCalls)
  })
})
