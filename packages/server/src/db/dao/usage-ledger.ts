import { estimateCost, priceFor, type TokenUsage } from '@octopus/shared'

/**
 * UsageLedger 写侧（C3 · ADR-0016）。
 * node_token_usages 是全站总量唯一账本（D4）；它的写入口收敛在
 * TokenUsageDAO.recordNodeUsage，本模块提供其唯一的 cost 决策函数。
 */

export type NodeUsageSource = 'node' | 'interaction' | 'harness'

/**
 * ledger 的 cost 三态（与 shared/ledger.LedgerCost 语义一致）：
 * 上游给价（SDK/calibrate）→ 用；没给 → shared 价表估算（C2 补价通道）；
 * 仍查不到 → null = 未定价。**任何环节都不把未知焊成 0。**
 */
export function ledgerCostUsd(
  usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>,
  model: string | null | undefined,
  given?: number | null,
): number | null {
  return given ?? estimateCost(usage, priceFor(model))
}
