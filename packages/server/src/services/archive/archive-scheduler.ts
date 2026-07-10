import { getConfigManager } from "../agent/config-manager"
import { getArchiveService } from "./archive-service"
import { logError, logInfo } from "../../file-logger"

export class ArchiveScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private isRunning = false

  constructor(
    private orgLister: () => string[],
    private intervalHours: number = 2,
  ) {}

  start(): () => void {
    const intervalMs = this.intervalHours * 60 * 60 * 1000
    this.timer = setInterval(() => this.run(), intervalMs)
    logInfo('archive scheduler started', { intervalHours: this.intervalHours })
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    logInfo('archive scheduler stopped')
  }

  async run(): Promise<void> {
    if (this.isRunning) {
      logInfo('archive scheduler skipped — previous run still active')
      return
    }
    this.isRunning = true
    try {
      const orgs = this.orgLister()
      let totalArchived = 0
      for (const org of orgs) {
        try {
          const archiveService = getArchiveService()
          if (!archiveService) continue
          const config = getConfigManager().getConfig(org)
          const result = await archiveService.archiveMemoryBatch(org, config.memory as { session_retention_days: number; long_term_refine_trigger_days: number })
          totalArchived += result.archived_count
        } catch (err) {
          logError('archive batch failed for org', err, { org })
        }
      }
      if (totalArchived > 0) {
        logInfo('memory archive completed', { totalArchived })
      }
    } finally {
      this.isRunning = false
    }
  }
}
