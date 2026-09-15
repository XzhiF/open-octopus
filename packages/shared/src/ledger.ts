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

// —— 写侧 SQL（all-sources-2 票02 / KD4 直写定案）——
//
// llm_calls / node_token_usages 的 INSERT/UPSERT 唯一文本源：server DAO 与 CLI 直写
// 进程共用，加列不漂移。占位符与绑定顺序在两侧固定：
// - insertLlmCall：named params（better-sqlite3 @col，25 列全量）
// - upsertNodeUsage：位置参数 12 个，顺序 = VALUES (?,×12)；同 id 冲突累加
//   （engine/harness 确定式 id 重跑语义），chat/cli 侧防重放靠存在性检查。

export const USAGE_WRITE_SQL = {
  insertLlmCall: `
    INSERT OR IGNORE INTO llm_calls (
      id, node_execution_id, execution_id, turn_index, call_index, message_id,
      model, stop_reason, timestamp, duration_ms, ttft_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, org, workspace_id, workflow_ref, node_id, session_id, instance_id,
      source, trace_id, span_id
    ) VALUES (
      @id, @node_execution_id, @execution_id, @turn_index, @call_index,
      @message_id, @model, @stop_reason, @timestamp, @duration_ms, @ttft_ms,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @cost_usd, @org, @workspace_id, @workflow_ref, @node_id, @session_id, @instance_id,
      @source, @trace_id, @span_id
    )`,
  upsertNodeUsage: `
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, source, created_at, session_id, trace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cost_usd = CASE
        WHEN node_token_usages.cost_usd IS NULL AND excluded.cost_usd IS NULL THEN NULL
        ELSE COALESCE(node_token_usages.cost_usd, 0) + COALESCE(excluded.cost_usd, 0)
      END,
      created_at = excluded.created_at`,
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

/** 已有一份合并好的 usage + 各行 cost 时直出 totals（SSE live 累计用）。 */
export function totalsFromUsage(usage: TokenUsage, costs: readonly (number | null | undefined)[]): LedgerTotals {
  return {
    tokens: totalTokens(usage),
    cost: costSummary(costs),
    cacheHitRate: cacheHitRateOf(usage),
  }
}
