import { emptyTokenUsage, addTokenUsage, totalTokens, type TokenUsage } from './types/usage'

/**
 * UsageLedger 公式层（C3 · ADR-0016）。
 *
 * 全站「总量」只有这里的一份 JS 定义 + `LEDGER_SQL` 的一份 SQL 镜像：
 * - 聚合端点（REST/SSE/CLI/归档）必须输出本模块的 `LedgerTotals` 形状；
 * - DAO 里 GROUP BY 级聚合必须用 `LEDGER_SQL.*` 拼表达式，禁止手写 SUM；
 * - 金表测试（server/ledger-sql-mirror）钉死两者在同一数据集上逐位相等。
 *
 * 口径共识（ADR-0016）：
 * - 总 tokens = 四字段和（含 cache），折叠口径（in+cacheRead / in+out）全站废除；
 * - cost 为「价表估算之和」（C2：不存在账单实测），NULL=未定价——
 *   全组未定价 → usd=null；部分定价 → usd=已知部分和 + complete=false；
 * - cacheHitRate = cacheRead/(input+cacheRead)，值域 0–1，分母 0 → null（不造假 0%）。
 */

export interface LedgerCost {
  /** 已定价行的部分和；一行都无价 → null（显示「—」，不是 $0） */
  usd: number | null
  /** true = 组内每一行都有价，usd 即全量；false = 部分和（UI 标 ≈） */
  complete: boolean
}

export interface LedgerTotals {
  tokens: number
  cost: LedgerCost
  /** 0–1 比率；无输入类 token → null */
  cacheHitRate: number | null
}

/** ledger 聚合的行输入：规范四字段 + 可空 cost。 */
export type LedgerRow = TokenUsage & { costUsd?: number | null }

// —— SQL 镜像（唯一允许出现在 DAO 里的聚合表达式来源）——

/** 表/别名前缀写法：如 'ntu.' 或 ''。输出列名与 JS 侧字段对应。 */
export const LEDGER_SQL = {
  /** 总 tokens（四字段全口径） */
  sumTokens: (p = '') =>
    `SUM(${p}input_tokens + ${p}output_tokens + ${p}cache_read_tokens + ${p}cache_creation_tokens)`,
  /** 已定价部分和；全 NULL 组 → NULL（配合 costComplete 使用） */
  sumCost: (p = '') =>
    `CASE WHEN COUNT(${p}cost_usd) = 0 THEN NULL ELSE COALESCE(SUM(${p}cost_usd), 0) END`,
  /** 每组是否全部有价（空组 0=0 → 1，vacuous true，与 JS costSummary([]) 对齐） */
  costComplete: (p = '') =>
    `COUNT(*) = COUNT(${p}cost_usd)`,
  /** cache 命中率 0–1；input+cacheRead 为 0 → NULL */
  cacheHitRate: (p = '') =>
    `CASE WHEN SUM(${p}input_tokens + ${p}cache_read_tokens) > 0 ` +
    `THEN CAST(SUM(${p}cache_read_tokens) AS REAL) / SUM(${p}input_tokens + ${p}cache_read_tokens) ` +
    `ELSE NULL END`,
} as const

// —— JS 侧公式 ——

export function costSummary(costs: readonly (number | null | undefined)[]): LedgerCost {
  let sum = 0
  let priced = 0
  for (const c of costs) {
    if (c == null) continue
    sum += c
    priced++
  }
  return {
    usd: priced === 0 ? null : sum,
    complete: priced === costs.length,
  }
}

export function cacheHitRateOf(u: TokenUsage): number | null {
  const den = u.inputTokens + u.cacheReadTokens
  return den > 0 ? u.cacheReadTokens / den : null
}

/** 跨行聚合成唯一规范的 totals（组内先合并 usage，再出三个量）。 */
export function ledgerTotals(rows: readonly LedgerRow[]): LedgerTotals {
  const usage = rows.reduce<TokenUsage>((acc, r) => addTokenUsage(acc, r), emptyTokenUsage())
  return {
    tokens: totalTokens(usage),
    cost: costSummary(rows.map(r => r.costUsd)),
    cacheHitRate: cacheHitRateOf(usage),
  }
}

/** 已有一份合并好的 usage + 各行 cost 时直出 totals（SSE live 累计用）。 */
export function totalsFromUsage(usage: TokenUsage, costs: readonly (number | null | undefined)[]): LedgerTotals {
  return {
    tokens: totalTokens(usage),
    cost: costSummary(costs),
    cacheHitRate: cacheHitRateOf(usage),
  }
}
