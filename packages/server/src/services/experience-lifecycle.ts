// packages/server/src/services/experience-lifecycle.ts
// ExperienceLifecycleService — Phase 4 of Execution Memory: Lifecycle Management.
// Handles resolving experiences from PR merges, decaying stale entries, and cleanup.

import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { KnowledgeFilesService } from "./knowledge-files"

export class ExperienceLifecycleService {
  constructor(
    private experienceDAO: ExperienceDAO,
    private knowledgeFiles: KnowledgeFilesService,
  ) {}

  /**
   * Mark experiences as resolved based on PR body keywords.
   * Extracts BUG-\d+/FIX-\d+/ISSUE-\d+ patterns from PR description.
   * Returns the number of experiences marked as resolved.
   */
  markResolved(prBody: string, prUrl: string): number {
    const count = this.experienceDAO.markResolved(prBody, prUrl)
    if (count > 0) {
      console.log(`[ExperienceLifecycle] Marked ${count} experiences as resolved via PR: ${prUrl}`)
    }
    return count
  }

  /**
   * Decay stale experiences: use_count=0 AND created > N days ago → obsolete.
   * Default: 90 days.
   */
  decayStale(days = 90): number {
    const count = this.experienceDAO.decayStale(days)
    if (count > 0) {
      console.log(`[ExperienceLifecycle] Decayed ${count} stale experiences (>${days} days, use_count=0)`)
    }
    return count
  }

  /**
   * Physical deletion of obsolete experiences older than N days.
   * Used by DataRetentionService for periodic cleanup.
   */
  cleanupObsolete(days = 180): number {
    const count = this.experienceDAO.deleteObsolete(days)
    if (count > 0) {
      console.log(`[ExperienceLifecycle] Cleaned up ${count} obsolete experiences (>${days} days)`)
    }
    return count
  }
}
