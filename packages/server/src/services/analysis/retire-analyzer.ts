import { EvolutionConfigService } from '../scheduler/evolution-config'
import { UsageTrackerService, WorkflowUsageStats } from '../scheduler/usage-tracker'

// ── Types ──────────────────────────────────────────────────────────

export interface RetireCandidate {
  workflowId: string
  usageRate: number
  failureRate: number
  lastExecution: string | null
  reason: string[]
  impact: 'low' | 'medium' | 'high'
}

// ── RetireAnalyzer ─────────────────────────────────────────────────

/**
 * Identifies workflows that are candidates for retirement based on
 * low usage and/or high failure rates, while respecting the protected list.
 */
export class RetireAnalyzer {
  private configService: EvolutionConfigService
  private usageTracker: UsageTrackerService

  constructor(configService: EvolutionConfigService, usageTracker: UsageTrackerService) {
    this.configService = configService
    this.usageTracker = usageTracker
  }

  /**
   * Analyse all workflows and return those eligible for retirement.
   *
   * @param days           Look-back window in days
   * @param usageThreshold Max usage rate (runs/day) to qualify as "low usage"
   * @param failureThreshold Min failure rate to qualify as "high failure"
   */
  analyzeRetireCandidates(
    days = 90,
    usageThreshold = 0.05,
    failureThreshold = 0.5,
  ): RetireCandidate[] {
    const all = this.usageTracker.listAllWorkflowStats(days)
    const protectedSet = new Set(this.getRetireProtected('default'))

    const candidates: RetireCandidate[] = []

    for (const stats of all) {
      // Extract a short id from the workflow ref (e.g. "prd-impl" from "prd-impl.yaml")
      const shortId = stats.workflow_ref.replace(/\.ya?ml$/i, '')

      // Skip protected workflows
      if (protectedSet.has(shortId) || protectedSet.has(stats.workflow_ref)) continue

      const reasons: string[] = []

      if (stats.usage_rate < usageThreshold) {
        reasons.push(`Low usage: ${stats.usage_rate.toFixed(3)} runs/day (threshold ${usageThreshold})`)
      }

      if (stats.failure_rate > failureThreshold) {
        reasons.push(`High failure rate: ${(stats.failure_rate * 100).toFixed(0)}% (threshold ${(failureThreshold * 100).toFixed(0)}%)`)
      }

      if (reasons.length === 0) continue

      candidates.push({
        workflowId: stats.workflow_ref,
        usageRate: stats.usage_rate,
        failureRate: stats.failure_rate,
        lastExecution: null, // DAO doesn't expose last-run timestamp; consumers can enrich
        reason: reasons,
        impact: this.assessImpact(stats),
      })
    }

    // Sort: highest impact first, then lowest usage
    candidates.sort((a, b) => {
      const impactOrder = { high: 0, medium: 1, low: 2 }
      if (impactOrder[a.impact] !== impactOrder[b.impact]) {
        return impactOrder[a.impact] - impactOrder[b.impact]
      }
      return a.usageRate - b.usageRate
    })

    return candidates
  }

  /** Proxy to config service for CLI convenience. */
  getRetireProtected(org: string): string[] {
    return this.configService.getRetireProtected(org)
  }

  // ── Impact heuristic ───────────────────────────────────────────────

  private assessImpact(stats: WorkflowUsageStats): 'low' | 'medium' | 'high' {
    // High impact: still running somewhat often but failing a lot
    if (stats.usage_rate >= 0.1 && stats.failure_rate > 0.5) return 'high'
    // Medium: some usage, moderate failures
    if (stats.usage_rate >= 0.05 || stats.failure_rate > 0.3) return 'medium'
    return 'low'
  }
}
