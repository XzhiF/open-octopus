// packages/server/src/services/archive-recovery.ts
import fs from "fs"
import type { WorkspaceDAO } from "../db/dao/workspace-dao"

/**
 * ArchiveRecoveryService — handles two recovery scenarios:
 *
 * 1. Workspace files still exist after `archived` status — retry file deletion
 * 2. Workspace stuck in `archiving` for too long — reset to `none`
 *
 * Runs on a configurable interval (default 5 minutes).
 */
export class ArchiveRecoveryService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private workspaceDAO: WorkspaceDAO,
    private scanIntervalMs: number = 5 * 60 * 1000, // 5 minutes
  ) {}

  start(): void {
    // Run once at startup, then on interval
    try { this.scan() } catch (err) {
      console.warn("[archive-recovery] Initial scan failed:", err)
    }
    this.timer = setInterval(() => this.scan(), this.scanIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  scan(): void {
    this.retryCleanup()
    this.recoverTimedOut()
  }

  /**
   * Scenario 1: Workspace has `archived` status but files still exist.
   * Retry file deletion.
   */
  retryCleanup(): void {
    try {
      const archived = this.workspaceDAO.findArchivedWithFiles()
      for (const ws of archived) {
        try {
          const resolvedPath = ws.path.replace(/^~/, require("os").homedir())
          if (fs.existsSync(resolvedPath)) {
            fs.rmSync(resolvedPath, { recursive: true, force: true })
          }
          // If directory was deleted successfully (or didn't exist), that's fine.
          // The workspace record is already deleted from DB in the normal flow.
        } catch (err) {
          console.warn(`[archive-recovery] File cleanup retry failed for ${ws.id}:`, err)
          // Will retry on next scan
        }
      }
    } catch (err) {
      console.warn("[archive-recovery] retryCleanup scan failed:", err)
    }
  }

  /**
   * Scenario 2: Workspace stuck in `archiving` for too long.
   * Reset to `none` so the user can retry.
   */
  recoverTimedOut(thresholdMinutes: number = 30): void {
    try {
      const timedOut = this.workspaceDAO.getArchiveTimedOut(thresholdMinutes)
      for (const ws of timedOut) {
        this.workspaceDAO.setArchiveStatus(ws.id, "none")
        console.log(`[archive-recovery] Reset timed-out archive for workspace ${ws.id}`)
      }
    } catch (err) {
      console.warn("[archive-recovery] recoverTimedOut scan failed:", err)
    }
  }
}
