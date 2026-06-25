import Database from 'better-sqlite3'
import { ScheduleConfigDAO } from '../../db/dao'

const MAX_CONSECUTIVE_FAILURES = 5

/**
 * Tracks consecutive failures per schedule.
 * Auto-disables the schedule after MAX_CONSECUTIVE_FAILURES consecutive failures.
 *
 * recordFailure is atomic: the increment and the auto-disable decision run in
 * a single transaction so concurrent failures cannot race past the threshold
 * or double-disable.
 */
export class ConsecutiveFailureTracker {
  private configDAO: ScheduleConfigDAO

  constructor(configDAO: ScheduleConfigDAO) {
    this.configDAO = configDAO
  }

  recordSuccess(scheduleId: string): void {
    this.configDAO.resetConsecutiveFailures(scheduleId)
  }

  recordFailure(scheduleId: string): { autoDisabled: boolean } {
    const txn = this.configDAO.transaction(() => {
      this.configDAO.incrementConsecutiveFailures(scheduleId)

      const row = this.configDAO.getConsecutiveFailuresAndEnabled(scheduleId)

      if (row && row.consecutive_failures >= MAX_CONSECUTIVE_FAILURES && row.enabled === 1) {
        this.configDAO.autoDisableSchedule(scheduleId)
        return { autoDisabled: true } as const
      }
      return { autoDisabled: false } as const
    })

    return txn
  }
}
