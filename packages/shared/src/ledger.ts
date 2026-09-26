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
  /** 任意「可空 cost 列」的通用版（冻结聚合表等非账本表用），col 传全限定列名 */
  sumCostOf: (col: string) =>
    `CASE WHEN COUNT(${col}) = 0 THEN NULL ELSE COALESCE(SUM(${col}), 0) END`,
  costCompleteOf: (col: string) =>
    `COUNT(*) = COUNT(${col})`,
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

/** 单份账本汇总（usage + cost），供跨执行合并。 */
export interface LedgerPart {
  usage: TokenUsage
  cost: LedgerCost
}

/**
 * 跨执行/跨组合并唯一公式（web TaskAiUsageCard 旧 V4 加权 bug 的根治）：
 * usage 逐字段相加；cost = 已知部分和（全 null → null），complete = 全部且无 null；
 * hitRate 用合并后 usage 重算（分母加权天然正确）。
 */
export function mergeLedgerParts(parts: readonly LedgerPart[]): { usage: TokenUsage; totals: LedgerTotals } {
  const usage = parts.reduce<TokenUsage>((acc, p) => addTokenUsage(acc, p.usage), emptyTokenUsage())
  let usd: number | null = null
  let complete = true
  for (const p of parts) {
    if (p.cost.usd === null) { if (p.cost.complete) continue; complete = false; continue }
    usd = (usd ?? 0) + p.cost.usd
    if (!p.cost.complete) complete = false
  }
  return {
    usage,
    totals: { tokens: totalTokens(usage), cost: { usd, complete }, cacheHitRate: cacheHitRateOf(usage) },
  }
}

// —— 账本聚合的 wire 形状（会话/任务/看板列各级读模型共用）——

/** 一组 llm_calls 的用量摘要：请求数 + 规范四字段 + totals。 */
export interface LlmUsageSummary {
  totalCalls: number
  usage: TokenUsage
  totals: LedgerTotals
}

/** 按模型粒度的分解；costUsd = null 表示该模型全未定价（不焊 0）。 */
export interface ModelUsageBreakdown {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
}

export interface LlmUsageAggregates extends LlmUsageSummary {
  modelBreakdown: Record<string, ModelUsageBreakdown>
}

/** 逐 call 行折叠成会话级聚合的行输入：规范四字段 + 可空 cost + 模型名。 */
export type LlmUsageRow = LedgerRow & { model?: string | null }

/**
 * 逐 call 行 → 会话口径聚合（聊天角标 / 明细 popover 的唯一算法）。
 * **不去重** —— 去重属执行口径（并行票共享会话的历史 bug），调用方若拿到的是
 * 执行行需自行按 message_id 折叠；会话行是「每 modelUsage 一行」的真实拆分。
 */
export function llmUsageAggregates(rows: readonly LlmUsageRow[]): LlmUsageAggregates {
  const usage = rows.reduce<TokenUsage>((acc, r) => addTokenUsage(acc, r), emptyTokenUsage())
  const modelBreakdown: Record<string, ModelUsageBreakdown> = {}
  const costs: Record<string, Array<number | null | undefined>> = {}
  for (const r of rows) {
    const model = r.model ?? 'unknown'
    if (!modelBreakdown[model]) {
      modelBreakdown[model] = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }
      costs[model] = []
    }
    const b = modelBreakdown[model]
    b.calls += 1
    b.inputTokens += r.inputTokens
    b.outputTokens += r.outputTokens
    b.cacheReadTokens += r.cacheReadTokens
    b.cacheCreationTokens += r.cacheCreationTokens
    costs[model].push(r.costUsd)
  }
  for (const [model, list] of Object.entries(costs)) {
    modelBreakdown[model].costUsd = costSummary(list).usd
  }
  return { totalCalls: rows.length, usage, totals: ledgerTotals(rows), modelBreakdown }
}

/**
 * 跨组（任务 → 看板列）合并用量摘要的唯一公式：`mergeLedgerParts` 的摘要层包装，
 * 请求数逐组相加。空集/全 null → null（消费方显示「—」，不显示 0）。
 */
export function mergeLlmUsageSummaries(
  list: readonly (LlmUsageSummary | null | undefined)[],
): LlmUsageSummary | null {
  const parts = list.filter((x): x is LlmUsageSummary => x != null)
  if (parts.length === 0) return null
  const merged = mergeLedgerParts(parts.map(p => ({ usage: p.usage, cost: p.totals.cost })))
  return {
    totalCalls: parts.reduce((n, p) => n + p.totalCalls, 0),
    usage: merged.usage,
    totals: merged.totals,
  }
}

