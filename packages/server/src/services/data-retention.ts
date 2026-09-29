// packages/server/src/services/data-retention.ts
// Periodic cleanup of expired data — extracted from error-tracker.ts setupDataRetention()
import type { ExecutionDAO, ScheduleRunDAO } from '../db/dao'

export class DataRetentionService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private execDAO: ExecutionDAO,
    private runDAO: ScheduleRunDAO,
  ) {}

  /**
   * Start the periodic cleanup interval (every 6 hours).
   * Returns a stop function that clears the interval.
   */
  start(): () => void {
    this.timer = setInterval(() => { void this.runCleanup() }, 6 * 60 * 60 * 1000)
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run a single cleanup cycle — exposed for testing. */
  async runCleanup(): Promise<void> {
    try {
      const now = Date.now()

      // Agent events: truncate content after 30d, delete rows after 90d
      // 票6a void 收紧：三处 execDAO 写已 PG 异步（B5 票5），runCleanup 本身是
      // async 且整段有 try/catch 收口 —— 直接 await（能 await 则 await，
      // 消除 orphan promise 跨文件串扰）。
      const cutoff30d = now - 30 * 86_400_000
      await this.execDAO.truncateOldAgentEventContent(cutoff30d)

      const cutoff90d = now - 90 * 86_400_000
      await this.execDAO.deleteOldAgentEvents(cutoff90d)

      // LLM calls: delete after 365d
      const cutoff365d = now - 365 * 86_400_000
      await this.execDAO.deleteOldLlmCalls(cutoff365d)

      // Schedule executions: 90-day retention
      const cutoff90iso = new Date(cutoff90d).toISOString()
      await this.runDAO.deleteOldScheduleExecutions(cutoff90iso)

      // VACUUM only when significant data was deleted (every 24h+ or manual)
      // Not auto-VACUUM: can block for seconds on large databases
    } catch (err) {
      console.error('[DataRetention] Cleanup failed:', err)
    }
  }
}
