import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { addTokenUsage, emptyTokenUsage, totalTokens, ledgerTotals, type TokenUsage } from "@octopus/shared"
import { usageFromRow } from "../db/dao/usage-mapping"

/**
 * C3 端到端对账不变式（验收③）：同一次执行的「总 tokens / 总费用」——
 *   execution_metrics SSE 初值（aggregateByExecution）
 *   ≡ GET /executions steps 累加（findByExecutionPerStep + addTokenUsage，execution.ts 读法）
 *   ≡ observability summary（同一 aggregateByExecution）
 *   ≡ SSE live 逐节点累计（每 node_end 记一次 totals，累加）
 * 四路同源 ntu 后必须逐位相等（跳变的结构根除证明）。
 *
 * billing-core-1 票04：cost fixture 由「SDK 直报」换成 billing_price_config 配价
 * （KD2 —— SDK 价不再作账，四路一致不变式不变）。手算期望：
 *   claude-sonnet 双档均配 USD {3,15,3.75,0.3}（cache_write 对应 cc，cache_read 对应 cr）：
 *   a: 1000×3+200×15+300×3.75+5000×0.3 = 3000+3000+1125+1500 = 8625 → 0.008625
 *   b: 400×3+60×15+90×3.75+1200×0.3 = 1200+900+337.5+360 = 2797.5 → 0.0027975
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
  for (const r of rows) {
    dao.recordNodeUsage({
      id: `${neId}-token-${r.model}`, nodeExecutionId: neId, model: r.model,
      usage: { inputTokens: r.in, outputTokens: r.out, cacheReadTokens: r.cr, cacheCreationTokens: r.cc },
      source: 'node', createdAt: t,
    })
  }
}

describe('执行级总量四路一致 (C3)', () => {
  it('SSE 初值 ≡ steps 累加 ≡ live 逐节点累计（含混合定价）', () => {
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

    // 路 4: live 逐节点累计（SSE 运行中语义：每 node_end 增量累加到 totals）
    let live = emptyTokenUsage()
    let liveCosts: Array<number | null> = []
    for (const neId of ['e-1-a', 'e-1-b']) {
      const nodeRows = dao.findByNodeExecution(neId).map(r => usageFromRow(r))
      for (const u of nodeRows) live = addTokenUsage(live, u)
      liveCosts = liveCosts.concat(dao.findByNodeExecution(neId).map(r => r.cost_usd))
    }
    expect(totalTokens(live)).toBe(agg.totals.tokens)
    const liveTotals = ledgerTotals(
      dao.findByExecution('e-1').map(r => ({ ...usageFromRow(r), costUsd: r.cost_usd })),
    )
    expect(liveTotals).toEqual(agg.totals)

    // 三态断言：混合定价 → 部分和 + complete=false
    expect(agg.totals.cost.complete).toBe(false)
    expect(agg.totals.cost.usd).toBeCloseTo(0.0114225, 12) // 0.008625 + 0.0027975（手算，见头注）
    // 规范命中率：(5000+1200)/(1000+800+400+5000+1200) = 6200/8400
    expect(agg.totals.cacheHitRate).toBeCloseTo(6200 / 8400, 12)
  })
})
