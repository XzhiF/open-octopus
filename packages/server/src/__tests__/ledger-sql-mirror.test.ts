import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import {
  LEDGER_SQL, ledgerTotals, costSummary, cacheHitRateOf, addTokenUsage,
  emptyTokenUsage, totalTokens, type LedgerRow,
} from "@octopus/shared"

/**
 * C3 金表测试（验收②）：同一份账本数据，SQL 片段（LEDGER_SQL，DAO 读侧所用）
 * 与 JS 镜像函数（shared/ledger，SSE/actuator 所用）必须逐位相等。
 * 两定义任何一侧漂移，这里立刻红。
 */
let db: Database.Database
const P = "e-1-node-a" // node_execution_id

// 混合数据集：有价/无价/全0输入/带cache —— 覆盖三态全部分支
const FIXTURES: Array<LedgerRow & { id: string; model: string }> = [
  { id: "f1", model: "claude-sonnet-4-20250514", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheCreationTokens: 500, costUsd: 0.12 },
  { id: "f2", model: "claude-sonnet-4-20250514", inputTokens: 500, outputTokens: 100, cacheReadTokens: 3000, cacheCreationTokens: 100, costUsd: 0.03 },
  { id: "f3", model: "qwen3.7-max", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
  { id: "f4", model: "edge", inputTokens: 0, outputTokens: 77, cacheReadTokens: 0, cacheCreationTokens: 9, costUsd: null },
]

const now = () => new Date().toISOString()

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  const t = now()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/x','o',?,?)").run(t, t)
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e-1','ws-1','0','t.yaml','T','completed',?,?, 'o',?,?)`).run(t, t, t, t)
  db.prepare(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES (?, 'e-1', 'node-a', 'agent', 'completed', 0, 1, ?, ?)`).run(P, t, t)
  for (const f of FIXTURES) {
    db.prepare(`INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'node', ?)`)
      .run(f.id, P, "m-" + f.id, f.inputTokens, f.outputTokens, f.costUsd, f.cacheReadTokens, f.cacheCreationTokens, t)
  }
})
afterAll(() => db.close())

function sqlTotals(where: string) {
  return db.prepare(`
    SELECT
      COALESCE(${LEDGER_SQL.sumTokens('ntu.')}, 0) as tokens,
      ${LEDGER_SQL.sumCost('ntu.')} as cost_usd,
      ${LEDGER_SQL.costComplete('ntu.')} as cost_complete,
      ${LEDGER_SQL.cacheHitRate('ntu.')} as hit
    FROM node_token_usages ntu WHERE ${where}
  `).get() as { tokens: number; cost_usd: number | null; cost_complete: number; hit: number | null }
}

function jsTotals(rows: LedgerRow[]) {
  const t = ledgerTotals(rows)
  return { tokens: t.tokens, cost_usd: t.cost.usd, cost_complete: t.cost.complete ? 1 : 0, hit: t.cacheHitRate }
}

describe('LEDGER_SQL ≡ JS 镜像（金表）', () => {
  it('全量组：tokens/cost 三态/hitRate 逐位相等', () => {
    const sql = sqlTotals(`ntu.node_execution_id = '${P}'`)
    const js = jsTotals(FIXTURES)
    expect(sql.tokens).toBe(js.tokens)
    expect(sql.cost_usd).toBeCloseTo(js.cost_usd as number, 12)
    expect(sql.cost_complete).toBe(js.cost_complete) // 有 NULL 行 → 都不 complete
    expect(sql.hit).toBeCloseTo(js.hit as number, 12)
  })

  it('全有价子组：complete 两侧同步为 true', () => {
    const sql = sqlTotals(`ntu.id IN ('f1','f2')`)
    const js = jsTotals(FIXTURES.filter(f => ['f1', 'f2'].includes(f.id)))
    expect(sql.cost_complete).toBe(1)
    expect(js.cost_complete).toBe(1)
    expect(sql.cost_usd).toBeCloseTo(js.cost_usd as number, 12)
    expect(sql.tokens).toBe(js.tokens)
    expect(sql.hit).toBeCloseTo(js.hit as number, 12)
  })

  it('全无价子组：两侧都 usd=null', () => {
    const sql = sqlTotals(`ntu.id IN ('f3','f4')`)
    const js = jsTotals(FIXTURES.filter(f => ['f3', 'f4'].includes(f.id)))
    expect(sql.cost_usd).toBeNull()
    expect(js.cost_usd).toBeNull()
    expect(sql.cost_complete).toBe(js.cost_complete)
  })

  it('空组：tokens 0 / usd null / vacuous complete —— 两侧一致', () => {
    const sql = sqlTotals("ntu.id = 'nope'")
    expect(sql.tokens).toBe(0)
    expect(sql.cost_usd).toBeNull()
    expect(sql.cost_complete).toBe(1)
    expect(sql.hit).toBeNull()
    const empty = ledgerTotals([])
    expect(empty.tokens).toBe(0)
    expect(empty.cost).toEqual({ usd: null, complete: true })
    expect(empty.cacheHitRate).toBeNull()
  })

  it('纯输入为零组（f4 单独）：hitRate 两侧都 null（不造假 0%）', () => {
    const sql = sqlTotals("ntu.id = 'f4'")
    expect(sql.hit).toBeNull()
    expect(cacheHitRateOf(FIXTURES[3])).toBeNull()
  })

  it('totalTokens/addTokenUsage 与 sumTokens 片段在 fixture 累加上一致', () => {
    const merged = FIXTURES.reduce((acc, f) => addTokenUsage(acc, f), emptyTokenUsage())
    expect(totalTokens(merged)).toBe(FIXTURES.reduce((a, f) => a + totalTokens(f), 0))
    expect(sqlTotals(`ntu.node_execution_id = '${P}'`).tokens).toBe(totalTokens(merged))
  })

  it('costSummary 的已知和语义 == sumCost CASE（部分定价）', () => {
    const costs = FIXTURES.map(f => f.costUsd)
    expect(costSummary(costs).usd).toBeCloseTo(sqlTotals(`ntu.node_execution_id = '${P}'`).cost_usd as number, 12)
  })
})
