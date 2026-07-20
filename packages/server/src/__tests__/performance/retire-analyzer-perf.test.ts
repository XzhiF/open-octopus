/**
 * P5.8 — Performance tests for retire analysis at scale.
 * Generates 1000+ schedule records and measures throughput.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../db/schema'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'

const SCHEDULE_COUNT = 1200

function seedSchedulesWithMixedHistory(
  db: Database.Database,
  count: number,
): void {
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
    ) VALUES (?, 'perf', ?, '0 9 * * *', 'UTC',
      ?, 3600, 0, datetime('now'), datetime('now'),
      'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, ?, 10)
  `)

  const insertExecution = db.prepare(`
    INSERT INTO schedule_executions (
      id, schedule_id, status, trigger_type, triggered_at,
      timezone_offset, timezone_iana, duration_ms, created_at, completed_at, triggered_by
    ) VALUES (?, ?, ?, 'scheduled', ?, '+00:00', 'UTC', ?, ?, ?, 'scheduler')
  `)

  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const schedId = `retire-sched-${i}`
      const enabled = i % 3 === 0 ? 0 : 1
      const failures = i % 4 === 0 ? 5 : 0
      insertSchedule.run(schedId, `retire-wf-${i}`, enabled, failures)

      // 0-8 executions per schedule (some are "unused" → retire candidates)
      const execCount = i % 5 === 0 ? 0 : Math.min(8, 1 + (i % 7))
      for (let e = 0; e < execCount; e++) {
        const execId = `retire-exec-${i}-${e}`
        const isOld = i % 6 === 0
        const daysAgo = isOld ? 120 + e : e
        const triggeredAt = new Date(Date.now() - daysAgo * 86400_000).toISOString()
        const status = (e % 3 === 0 && i % 2 === 0) ? 'failed' : 'completed'
        const durationMs = 500 + Math.random() * 10000
        const completedAt = new Date(new Date(triggeredAt).getTime() + durationMs).toISOString()
        insertExecution.run(execId, schedId, status, triggeredAt, Math.round(durationMs), triggeredAt, completedAt)
      }
    }
  })
  tx()
}

describe('retire-analyzer performance', () => {
  let db: Database.Database
  let configDAO: ScheduleConfigDAO
  let runDAO: ScheduleRunDAO

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    configDAO = new ScheduleConfigDAO(db)
    runDAO = new ScheduleRunDAO(db)
  })

  afterEach(() => {
    db.close()
  })

  it(`processes ${SCHEDULE_COUNT} schedules for retire analysis within time limit`, () => {
    seedSchedulesWithMixedHistory(db, SCHEDULE_COUNT)

    const start = Date.now()
    const since = new Date(Date.now() - 90 * 86400_000).toISOString()
    const rates = runDAO.failureRateBySchedule(since)
    const elapsed = Date.now() - start

    expect(rates.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(300_000) // 5 minutes
  })

  it('identifies high-failure-rate schedules efficiently', () => {
    seedSchedulesWithMixedHistory(db, SCHEDULE_COUNT)

    const start = Date.now()
    const since = new Date(Date.now() - 90 * 86400_000).toISOString()
    const rates = runDAO.failureRateBySchedule(since)
    const highFailure = rates.filter((r) => r.rate > 0.3)
    const elapsed = Date.now() - start

    expect(highFailure.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(300_000)
  })

  it('counts running executions across 1200 schedules', () => {
    seedSchedulesWithMixedHistory(db, SCHEDULE_COUNT)

    const start = Date.now()
    const running = runDAO.countRunningExecutions()
    const elapsed = Date.now() - start

    expect(running).toBe(0)
    expect(elapsed).toBeLessThan(1000)
  })

  it('memory usage stays within bounds', () => {
    const memBefore = process.memoryUsage()
    seedSchedulesWithMixedHistory(db, SCHEDULE_COUNT)
    const memAfter = process.memoryUsage()

    const heapUsedMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)
    expect(heapUsedMB).toBeLessThan(500)
  })
})
