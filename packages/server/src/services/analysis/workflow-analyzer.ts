import { UsageTrackerService, WorkflowUsageStats } from '../scheduler/usage-tracker'

// ── Types ──────────────────────────────────────────────────────────

export interface InefficientWorkflow {
  workflowId: string
  avgDurationMs: number
  failureRate: number
  totalRuns: number
  suggestions: string[]
}

// ── WorkflowAnalyzer ───────────────────────────────────────────────

/**
 * Analyses workflow execution data to surface optimisation opportunities.
 * Rule-based suggestions: parallelise, cache, merge.
 */
export class WorkflowAnalyzer {
  private usageTracker: UsageTrackerService

  constructor(usageTracker: UsageTrackerService) {
    this.usageTracker = usageTracker
  }

  /**
   * Return the top-N most inefficient workflows ranked by a composite score
   * (failure rate × weight + inverse usage).
   */
  analyzeInefficientWorkflows(days = 30, topN = 10): InefficientWorkflow[] {
    const all = this.usageTracker.listAllWorkflowStats(days)

    const results: InefficientWorkflow[] = all.map(stats => ({
      workflowId: stats.workflow_ref,
      avgDurationMs: stats.avg_duration_ms ?? 0,
      failureRate: stats.failure_rate,
      totalRuns: stats.total_runs,
      suggestions: this.generateSuggestions(stats),
    }))

    // Sort: highest failure rate first, then longest duration
    results.sort((a, b) => {
      if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate
      return b.avgDurationMs - a.avgDurationMs
    })

    return results.slice(0, topN)
  }

  // ── Rule engine ────────────────────────────────────────────────────

  private generateSuggestions(stats: WorkflowUsageStats): string[] {
    const suggestions: string[] = []

    // Rule 1: High failure rate → investigate root cause
    if (stats.failure_rate > 0.5) {
      suggestions.push(
        `High failure rate (${(stats.failure_rate * 100).toFixed(0)}%). ` +
        `Review recent failures and add retry/error-handling.`,
      )
    } else if (stats.failure_rate > 0.2) {
      suggestions.push(
        `Moderate failure rate (${(stats.failure_rate * 100).toFixed(0)}%). ` +
        `Consider adding pre-flight checks.`,
      )
    }

    // Rule 2: Long-running workflows → parallelize
    // Heuristic: avgDuration > 10 min and many runs suggest sequential node chain
    if ((stats.avg_duration_ms ?? 0) > 600_000) {
      suggestions.push(
        `Average duration ${Math.round((stats.avg_duration_ms ?? 0) / 1000)}s exceeds 10 min. ` +
        `Review node dependency graph — sequential nodes > 3 may benefit from parallelization.`,
      )
    }

    // Rule 3: Low usage → consider caching or merging
    if (stats.usage_rate < 0.05 && stats.total_runs > 0) {
      suggestions.push(
        `Low usage (${stats.usage_rate.toFixed(3)} runs/day). ` +
        `Consider merging with a similar workflow or caching repeated computation results.`,
      )
    }

    // Rule 4: Very high run count with moderate duration → cache opportunity
    if (stats.total_runs > 50 && (stats.avg_duration_ms ?? 0) > 60_000) {
      suggestions.push(
        `High run count (${stats.total_runs}) with non-trivial duration. ` +
        `Evaluate whether outputs can be cached to avoid repeated computation.`,
      )
    }

    if (suggestions.length === 0) {
      suggestions.push('No obvious optimisation opportunities detected.')
    }

    return suggestions
  }
}
