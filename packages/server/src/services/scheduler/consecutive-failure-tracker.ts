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

  async recordSuccess(scheduleId: string): Promise<void> {
    await this.configDAO.resetConsecutiveFailures(scheduleId)
  }

  async recordFailure(scheduleId: string): Promise<{ autoDisabled: boolean }> {
    return this.configDAO.transaction(async (tx) => {
      const cfg = new ScheduleConfigDAO(tx)
      await cfg.incrementConsecutiveFailures(scheduleId)

      const row = await cfg.getConsecutiveFailuresAndEnabled(scheduleId)

      if (row && row.consecutive_failures >= MAX_CONSECUTIVE_FAILURES && row.enabled === 1) {
        await cfg.autoDisableSchedule(scheduleId)
        return { autoDisabled: true } as const
      }
      return { autoDisabled: false } as const
    })
  }
}
