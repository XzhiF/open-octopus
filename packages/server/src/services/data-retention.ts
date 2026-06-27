// packages/server/src/services/data-retention.ts
// Periodic cleanup of expired data — extracted from error-tracker.ts setupDataRetention()
import type { ExecutionDAO, ScheduleRunDAO } from '../db/dao'
import type { ArchiveDAO } from '../db/dao'
import type { ExperienceLifecycleService } from './experience-lifecycle'

export class DataRetentionService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private execDAO: ExecutionDAO,
    private runDAO: ScheduleRunDAO,
    private archiveDAO?: ArchiveDAO,
    private lifecycleSvc?: ExperienceLifecycleService,
  ) {}

  /**
   * Start the periodic cleanup interval (every 6 hours).
   * Returns a stop function that clears the interval.
   */
  start(): () => void {
    this.timer = setInterval(() => this.runCleanup(), 6 * 60 * 60 * 1000)
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run a single cleanup cycle — exposed for testing. */
  runCleanup(): void {
    try {
      const now = Date.now()

      // Agent events: truncate content after 30d, delete rows after 90d
      const cutoff30d = now - 30 * 86_400_000
      this.execDAO.truncateOldAgentEventContent(cutoff30d)

      const cutoff90d = now - 90 * 86_400_000
      this.execDAO.deleteOldAgentEvents(cutoff90d)

      // LLM calls: delete after 365d
      const cutoff365d = now - 365 * 86_400_000
      this.execDAO.deleteOldLlmCalls(cutoff365d)

      // Schedule executions: 90-day retention
      const cutoff90iso = new Date(cutoff90d).toISOString()
      this.runDAO.deleteOldScheduleExecutions(cutoff90iso)

      // Archive compression: clear node_summary for archives older than 1 year
      if (this.archiveDAO) {
        const cutoff1y = new Date(now - 365 * 86_400_000).toISOString()
        this.archiveDAO.clearNodeSummaryOlderThan(cutoff1y)
      }

      // Experience cleanup: delete obsolete experiences older than 180 days
      if (this.lifecycleSvc) {
        this.lifecycleSvc.cleanupObsolete(180)
      }

      // VACUUM only when significant data was deleted (every 24h+ or manual)
      // Not auto-VACUUM: can block for seconds on large databases
    } catch (err) {
      console.error('[DataRetention] Cleanup failed:', err)
    }
  }
}
