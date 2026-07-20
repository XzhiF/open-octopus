/**
 * SchedulerMonitor — alerting checks for scheduler health.
 * P5.7: Queue backlog, execution delay, failure rate, GitHub rate limit.
 */
import { execFileSync } from 'child_process'
import type { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'

// ── Types ──────────────────────────────────────────────────────────

export interface QueueBacklogResult {
  alert: boolean
  queueLength: number
}

export interface ExecutionDelayResult {
  alert: boolean
  delayedJobs: string[]
}

export interface FailureRateResult {
  alert: boolean
  highFailureWorkflows: Array<{ id: string; rate: number }>
}

export interface GitHubRateLimitResult {
  alert: boolean
  remaining: number
}

export interface MonitorReport {
  timestamp: string
  queueBacklog: QueueBacklogResult
  executionDelay: ExecutionDelayResult
  failureRate: FailureRateResult
  githubRateLimit: GitHubRateLimitResult
  anyAlert: boolean
}

// ── SchedulerMonitor ───────────────────────────────────────────────

export class SchedulerMonitor {
  constructor(
    private configDAO: ScheduleConfigDAO,
    private runDAO: ScheduleRunDAO,
  ) {}

  /**
   * Alert if more than `maxQueue` jobs are in triggered/running state.
   */
  checkQueueBacklog(maxQueue = 8): QueueBacklogResult {
    const running = this.runDAO.countRunningExecutions()
    return {
      alert: running > maxQueue,
      queueLength: running,
    }
  }

  /**
   * Alert if any scheduled executions have been waiting longer than thresholdMs.
   */
  checkExecutionDelay(thresholdMs = 300_000): ExecutionDelayResult {
    const cutoff = new Date(Date.now() - thresholdMs).toISOString()
    const delayed = this.runDAO.findDelayedExecutions(cutoff)
    return {
      alert: delayed.length > 0,
      delayedJobs: delayed,
    }
  }

  /**
   * Alert if any workflow's failure rate exceeds threshold over the given window.
   */
  checkFailureRate(threshold = 0.5, days = 7): FailureRateResult {
    const since = new Date(Date.now() - days * 86400_000).toISOString()
    const rows = this.runDAO.failureRateBySchedule(since)

    const high: Array<{ id: string; rate: number }> = []
    for (const row of rows) {
      if (row.rate > threshold) {
        high.push({ id: row.schedule_id, rate: row.rate })
      }
    }

    return {
      alert: high.length > 0,
      highFailureWorkflows: high,
    }
  }

  /**
   * Check GitHub API rate limit via `gh api rate_limit`.
   * Returns mock-safe result when gh CLI is unavailable.
   */
  checkGitHubRateLimit(): GitHubRateLimitResult {
    try {
      const raw = execFileSync('gh', ['api', 'rate_limit', '--jq', '.rate.remaining'], {
        encoding: 'utf-8',
        timeout: 10_000,
      })
      const remaining = parseInt(raw.trim(), 10)
      return {
        alert: remaining < 100,
        remaining: isNaN(remaining) ? -1 : remaining,
      }
    } catch {
      // gh CLI unavailable — not alerting, just unknown
      return { alert: false, remaining: -1 }
    }
  }

  /**
   * Run all monitoring checks and produce an aggregate report.
   */
  runAllChecks(opts?: {
    maxQueue?: number
    delayThresholdMs?: number
    failureThreshold?: number
    failureDays?: number
  }): MonitorReport {
    const queueBacklog = this.checkQueueBacklog(opts?.maxQueue)
    const executionDelay = this.checkExecutionDelay(opts?.delayThresholdMs)
    const failureRate = this.checkFailureRate(opts?.failureThreshold, opts?.failureDays)
    const githubRateLimit = this.checkGitHubRateLimit()

    return {
      timestamp: new Date().toISOString(),
      queueBacklog,
      executionDelay,
      failureRate,
      githubRateLimit,
      anyAlert:
        queueBacklog.alert ||
        executionDelay.alert ||
        failureRate.alert ||
        githubRateLimit.alert,
    }
  }
}
