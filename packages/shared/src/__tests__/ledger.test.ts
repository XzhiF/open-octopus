import { describe, it, expect } from 'vitest'
import { costSummary, cacheHitRateOf, ledgerTotals, totalsFromUsage, type LedgerRow } from '../ledger'
import { emptyTokenUsage } from '../types/usage'

const row = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0, costUsd?: number | null): LedgerRow =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd })

describe('costSummary — B 类 NULL 语义全站规范 (C3/Q3)', () => {
  it('全部有价 → 求和且 complete', () => {
    const r = costSummary([0.1, 0.2, 0.3])
    expect(r.complete).toBe(true)
    expect(r.usd).toBeCloseTo(0.6, 12)
  })
  it('全未定价 → usd null（显示 —，不是 $0）+ 空组 vacuous complete', () => {
    expect(costSummary([null, undefined, null])).toEqual({ usd: null, complete: false })
    expect(costSummary([])).toEqual({ usd: null, complete: true }) // 对齐 SQL COUNT(*)=COUNT(cost) 空组=1
  })
  it('部分定价 → 已知部分和 + complete=false（UI 标 ≈）', () => {
    const r = costSummary([0.5, null, 0.25])
    expect(r.complete).toBe(false)
    expect(r.usd).toBeCloseTo(0.75, 12)
  })
})

describe('cacheHitRateOf — 单公式 0–1 (C3/Q5)', () => {
  it('cacheRead/(input+cacheRead)，不含 cacheCreation/output', () => {
    expect(cacheHitRateOf({ ...emptyTokenUsage(), inputTokens: 300, outputTokens: 999, cacheReadTokens: 700, cacheCreationTokens: 555 }))
      .toBeCloseTo(0.7, 12)
  })
  it('分母 0 → null（不造假 0%）', () => {
    expect(cacheHitRateOf({ ...emptyTokenUsage(), outputTokens: 50, cacheCreationTokens: 10 })).toBeNull()
    expect(cacheHitRateOf(emptyTokenUsage())).toBeNull()
  })
})

describe('ledgerTotals — 跨行唯一总量 (C3/Q2+Q4)', () => {
  it('总 tokens = 四字段和（折叠口径废除：cache 全额计入）', () => {
    const t = ledgerTotals([row(100, 50, 1000, 20), row(1, 2, 3, 4)])
    expect(t.tokens).toBe(1180)
  })
  it('多行 cost 混合三态', () => {
    const t = ledgerTotals([row(10, 1, 0, 0, 0.4), row(20, 2), row(5, 1, 0, 0, null)])
    expect(t.cost).toEqual({ usd: 0.4, complete: false })
  })
  it('命中率用合并后的 usage（分母加权自然正确 —— 前端 V4 bug 的根治形）', () => {
    // 行A 率 = 900/(100+900) = 0.9；行B 率 = 100/(400+100) = 0.2
    // 规范合并 = (900+100)/((100+400)+(900+100)) = 1000/1500 ≈ 0.6667 ≠ 简单平均 0.55
    const t = ledgerTotals([row(100, 0, 900, 0), row(400, 0, 100, 0)])
    expect(t.cacheHitRate).toBeCloseTo(1000 / 1500, 12)
  })
  it('空集 → tokens 0 / cost null+vacuous / hitRate null', () => {
    expect(ledgerTotals([])).toEqual({
      tokens: 0,
      cost: { usd: null, complete: true },
      cacheHitRate: null,
    })
  })
  it('totalsFromUsage 与 ledgerTotals 对同一数据产出一致（SSE live 路径复用）', () => {
    const rows = [row(30, 5, 400, 60, 0.01), row(70, 15, 100, 40, null)]
    const merged = rows.reduce((a, r) => ({
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: a.cacheCreationTokens + r.cacheCreationTokens,
    }), emptyTokenUsage())
    expect(totalsFromUsage(merged, rows.map(r => r.costUsd))).toEqual(ledgerTotals(rows))
  })
})
