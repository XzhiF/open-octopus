import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { recordLlmCall } from "../services/llm-call-ledger"
import { addTokenUsage, emptyTokenUsage, totalTokens, ledgerTotals, type TokenUsage } from "@octopus/shared"
import { usageFromRow } from "../db/dao/usage-mapping"

/**
 * C3 端到端对账不变式（验收③）+ billing NEW-r2 口径翻转：
 *   token 账（node_token_usages）四路一致 —— 不变：
 *     execution_metrics SSE 初值（aggregateByExecution）
 *     ≡ GET /executions steps 累加（findByExecutionPerStep + addTokenUsage，execution.ts 读法）
 *     ≡ observability summary（同一 aggregateByExecution）
 *     ≡ SSE live 逐节点累计
 *   钱（NEW-r2）不落 ntu —— 费用一律从 llm_calls_costed 视图按窗口派生；
 *   不变式 = 「aggregateByExecution 的 cost ≡ 逐节点 costForNodeExecution 之和
 *   ≡ JS 侧 ledgerTotals(视图行)」，三处同一份 SQL 规则源。
 * 手算（USD {3,15,3.75,0.3}，cc×cache_write、cr×cache_read）：
 *   a 的 claude 行: 1000×3+200×15+300×3.75+5000×0.3 = 8625 → 0.008625
 *   b 的 claude 行: 400×3+60×15+90×3.75+1200×0.3 = 2797.5 → 0.0027975
 *   qwen3.7-max 不配价 → NULL → 部分和 0.0114225 且 complete=false（三态不变）。
 */
let db: Database.Database
let dao: TokenUsageDAO
let billing: BillingDAO

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  dao = new TokenUsageDAO(db)
  billing = new BillingDAO(db)
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/x','o',?,?)").run(t, t)
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e-1','ws-1','0','t.yaml','T','completed',?,?, 'o',?,?)`).run(t, t, t, t)
  for (const m of ["claude-sonnet-4-20250514", "claude-sonnet-4-5-20250827"]) {
    billing.createPrice({ id: `OE-${m}`, vendor: "e2e", model_id: m, input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3, currency: "USD" })
  }
})
afterEach(() => db.close())

function addNode(neId: string, nodeId: string, rows: Array<{ model: string; in: number; out: number; cr: number; cc: number }>) {
  const t = new Date().toISOString()
  db.prepare(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES (?, 'e-1', ?, 'agent', 'completed', 0, 10, ?, ?)`).run(neId, nodeId, t, t)
  rows.forEach((r, i) => {
    // token 账：ntu 唯一写入口（NEW-r2 纯 token）
    dao.recordNodeUsage({
      id: `${neId}-token-${r.model}`, nodeExecutionId: neId, model: r.model,
      usage: { inputTokens: r.in, outputTokens: r.out, cacheReadTokens: r.cr, cacheCreationTokens: r.cc },
      source: 'node', createdAt: t,
    })
    // 事实账：同一次调用在 llm_calls 的镜像行（真实链路里由 observability persist 落下）
    recordLlmCall({
      id: `${neId}-lc-${i}`, sourcePath: 'workflow', nodeExecutionId: neId, executionId: 'e-1',
      turnIndex: i + 1, callIndex: 0, model: r.model,
      usage: { inputTokens: r.in, outputTokens: r.out, cacheReadTokens: r.cr, cacheCreationTokens: r.cc },
      timestamp: 1700000000000 + i, durationMs: 100,
      org: 'o', workspaceId: 'ws-1', workflowRef: 't.yaml', nodeId,
    }, dao)
  })
}

describe('执行级总量四路一致 (C3) + 费用口径三处自洽 (NEW-r2)', () => {
  it('token：SSE 初值 ≡ steps 累加 ≡ live 逐节点累计（ntu 纯 token 账）', () => {
    addNode('e-1-a', 'a', [
      { model: 'claude-sonnet-4-20250514', in: 1000, out: 200, cr: 5000, cc: 300 },
      { model: 'qwen3.7-max', in: 800, out: 100, cr: 0, cc: 0 },
    ])
    addNode('e-1-b', 'b', [
      { model: 'claude-sonnet-4-5-20250827', in: 400, out: 60, cr: 1200, cc: 90 },
    ])

    // 路 1+3: aggregateByExecution（execution_metrics 与 observability summary 共用）
    const agg = dao.aggregateByExecution('e-1')

    // 路 2: steps 读法（execution.ts mapRawStep 的纯函数等价：per-step usage 再全并）
    const stepsUsage = dao.findByExecutionPerStep('e-1')
      .reduce<TokenUsage>((acc, r) => addTokenUsage(acc, usageFromRow(r)), emptyTokenUsage())
    expect(totalTokens(stepsUsage)).toBe(agg.totals.tokens)
    expect(stepsUsage).toEqual(agg.usage)

    // 路 4: live 逐节点累计（SSE 运行中语义：每 node_end 只累 token —— ntu 无钱列）
    let live = emptyTokenUsage()
    for (const neId of ['e-1-a', 'e-1-b']) {
      for (const r of dao.findByNodeExecution(neId)) live = addTokenUsage(live, usageFromRow(r))
    }
    expect(totalTokens(live)).toBe(agg.totals.tokens)
    // 规范命中率：(5000+1200)/(1000+800+400+5000+1200) = 6200/8400
    expect(agg.totals.cacheHitRate).toBeCloseTo(6200 / 8400, 12)
  })

  it('钱：aggregateByExecution.cost ≡ 逐节点派生之和 ≡ ledgerTotals(视图行)（同一规则源）', () => {
    addNode('e-1-a', 'a', [
      { model: 'claude-sonnet-4-20250514', in: 1000, out: 200, cr: 5000, cc: 300 },
      { model: 'qwen3.7-max', in: 800, out: 100, cr: 0, cc: 0 },
    ])
    addNode('e-1-b', 'b', [
      { model: 'claude-sonnet-4-5-20250827', in: 400, out: 60, cr: 1200, cc: 90 },
    ])

    const agg = dao.aggregateByExecution('e-1')

    // 逐节点现算（node_end SSE 同源）：a = 0.008625 + NULL(qwen)，b = 0.0027975
    const aCost = dao.costForNodeExecution('e-1-a')
    const bCost = dao.costForNodeExecution('e-1-b')
    expect(aCost.usd).toBeCloseTo(0.008625, 12)
    expect(aCost.complete).toBe(false) // 组内含未配价行 → 三态部分和
    expect(bCost.usd).toBeCloseTo(0.0027975, 12)
    expect(bCost.complete).toBe(true)
    expect((aCost.usd ?? 0) + (bCost.usd ?? 0)).toBeCloseTo(agg.totals.cost.usd ?? 0, 12)

    // JS 镜像：对视图行跑 ledgerTotals，与 SQL 侧 totals 逐字段一致（tokens 来自镜像 ntu 行）
    const viewRows = db.prepare(`
      SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM llm_calls_costed WHERE execution_id = 'e-1'
    `).all() as Array<{ input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number | null }>
    const viewTotals = ledgerTotals(viewRows.map(r => ({
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
      costUsd: r.cost_usd,
    })))
    expect(viewTotals.tokens).toBe(agg.totals.tokens)
    expect(viewTotals.cost.complete).toBe(agg.totals.cost.complete)
    expect(viewTotals.cost.usd).toBeCloseTo(agg.totals.cost.usd ?? NaN, 12)
    expect(viewTotals.cacheHitRate).toBeCloseTo(agg.totals.cacheHitRate ?? NaN, 12)

    // 三态断言（口径不变）：混合定价 → 部分和 + complete=false
    expect(agg.totals.cost.complete).toBe(false)
    expect(agg.totals.cost.usd).toBeCloseTo(0.0114225, 12) // 0.008625 + 0.0027975（手算，见头注）
  })

  it('NEW-r2 表形状：ntu 行无 cost_usd（钱从账本列彻底消失）', () => {
    addNode('e-1-a', 'a', [{ model: 'claude-sonnet-4-20250514', in: 1, out: 1, cr: 0, cc: 0 }])
    const r = db.prepare("SELECT * FROM node_token_usages WHERE id='e-1-a-token-claude-sonnet-4-20250514'").get() as Record<string, unknown>
    expect(r).not.toHaveProperty('cost_usd')
  })
})
