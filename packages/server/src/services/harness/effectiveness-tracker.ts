// packages/server/src/services/harness/effectiveness-tracker.ts
//
// Effectiveness Tracker — builds prompt sections from success rate statistics
// and provides cold-start protection for the harness delegation prompt.
//
// Ticket 04 — AC-5, AC-6, AC-7.

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Stats for a single decision or pattern tag.
 * Mirrors the shape returned by EvolutionDAO.getSuccessStats().
 */
interface DecisionStat {
  success: number
  failed: number
  pending: number
  total: number
  rate: number
}

interface SuccessStats {
  decisionStats: Record<string, DecisionStat>
  patternStats: Record<string, DecisionStat>
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum number of resolved data points required before injecting
 * success rate statistics into the delegation prompt.
 * Below this threshold, we show a cold-start placeholder instead.
 *
 * Spec decision #8: "< 5 数据点时跳过成功率注入"
 */
export const COLD_START_THRESHOLD = 5

// ─── Cold Start Placeholder ──────────────────────────────────────────────────

/**
 * Build a cold-start placeholder string for the delegation prompt.
 * Shown when there are fewer than COLD_START_THRESHOLD data points.
 */
export function buildColdStartPlaceholder(): string {
  return `## 历史经验统计

经验积累中... (数据不足 ${COLD_START_THRESHOLD} 条，暂无统计数据)`
}

// ─── Stats Prompt Builder ────────────────────────────────────────────────────

/**
 * Build a prompt section from success rate statistics.
 * Injected into the delegation prompt when ≥ COLD_START_THRESHOLD data points exist.
 *
 * Format:
 * ```
 * ## 历史经验统计
 *
 * 基于历史干预数据，以下决策的成功率供参考：
 * - fix_and_retry: 成功率 80% (8成功 / 10已解决)
 * - guide_and_retry: 成功率 50% (3成功 / 6已解决)
 * ```
 *
 * AC-7: rate = count(success) / count(success + failed) per decision×detector
 */
export function buildDelegationPromptWithStats(stats: SuccessStats): string {
  const { decisionStats } = stats
  const entries = Object.entries(decisionStats)

  if (entries.length === 0) {
    return ""
  }

  const lines = [
    "## 历史经验统计",
    "",
    "基于历史干预数据，以下决策的成功率供参考：",
  ]

  // Sort by success rate descending to highlight best performers
  const sorted = entries.sort(([, a], [, b]) => b.rate - a.rate)

  for (const [decision, stat] of sorted) {
    const resolved = stat.success + stat.failed
    if (resolved === 0) {
      // All pending — show a note
      lines.push(`- ${decision}: 尚无已解决案例 (${stat.pending} 待定)`)
    } else {
      const percent = Math.round(stat.rate * 100)
      lines.push(`- ${decision}: 成功率 ${percent}% (${stat.success}成功 / ${resolved}已解决)`)
    }
  }

  return lines.join("\n")
}

// ─── Cold Start Check ────────────────────────────────────────────────────────

/**
 * Check whether we have enough data points to inject stats.
 * Returns true if stats should be injected, false if cold start placeholder should be used.
 */
export function hasEnoughDataPoints(stats: SuccessStats): boolean {
  const totalDataPoints = Object.values(stats.decisionStats).reduce(
    (sum, s) => sum + s.total,
    0,
  )
  return totalDataPoints >= COLD_START_THRESHOLD
}

/**
 * Build the stats section for the delegation prompt.
 * Handles cold start protection automatically:
 * - If < COLD_START_THRESHOLD data points → returns cold start placeholder
 * - If ≥ COLD_START_THRESHOLD data points → returns formatted stats
 * - If no stats at all → returns empty string
 */
export function buildStatsSection(stats: SuccessStats): string {
  const entries = Object.entries(stats.decisionStats)
  if (entries.length === 0) {
    return ""
  }

  if (!hasEnoughDataPoints(stats)) {
    return buildColdStartPlaceholder()
  }

  return buildDelegationPromptWithStats(stats)
}
