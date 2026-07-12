/**
 * P5.8 — Performance tests for workflow analysis at scale.
 * Generates 1000+ mock execution records and measures throughput.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../db/schema'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'

const WORKFLOW_COUNT = 1000
const EXECUTIONS_PER_WORKFLOW = 10

function seedScheduleExecutions(
  db: Database.Database,
  configDAO: ScheduleConfigDAO,
  runDAO: ScheduleRunDAO,
  count: number,
): void {
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
    ) VALUES (?, 'perf', ?, '0 9 * * *', 'UTC',
      1, 3600, 0, datetime('now'), datetime('now'),
      'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
  `)

  const insertExecution = db.prepare(`
    INSERT INTO schedule_executions (
      id, schedule_id, status, trigger_type, triggered_at,
      timezone_offset, timezone_iana, duration_ms, created_at, completed_at, triggered_by
    ) VALUES (?, ?, ?, 'scheduled', ?, '+00:00', 'UTC', ?, ?, ?, 'scheduler')
  `)

  const tx = db.transaction(() => {
    for (let w = 0; w < count; w++) {
      const schedId = `perf-sched-${w}`
      insertSchedule.run(schedId, `workflow-${w}`)

      for (let e = 0; e < EXECUTIONS_PER_WORKFLOW; e++) {
        const execId = `perf-exec-${w}-${e}`
        const status = e % 5 === 0 ? 'failed' : 'completed'
        const triggeredAt = new Date(Date.now() - (count * EXECUTIONS_PER_WORKFLOW - w * EXECUTIONS_PER_WORKFLOW - e) * 60000).toISOString()
        const durationMs = 1000 + Math.random() * 50000
        const completedAt = new Date(new Date(triggeredAt).getTime() + durationMs).toISOString()
        insertExecution.run(execId, schedId, status, triggeredAt, Math.round(durationMs), triggeredAt, completedAt)
      }
    }
  })
  tx()
}

describe('workflow-analyzer performance', () => {
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

  it(`processes ${WORKFLOW_COUNT} workflows with ${EXECUTIONS_PER_WORKFLOW} executions each within time limit`, () => {
    // Seed data
    seedScheduleExecutions(db, configDAO, runDAO, WORKFLOW_COUNT)

    // Measure failure rate analysis (the most expensive monitoring query)
    const start = Date.now()
    const since = new Date(Date.now() - 30 * 86400_000).toISOString()
    const rates = runDAO.failureRateBySchedule(since)
    const elapsed = Date.now() - start

    expect(rates.length).toBe(WORKFLOW_COUNT)
    expect(elapsed).toBeLessThan(300_000) // 5 minutes
  })

  it('counts running executions efficiently', () => {
    seedScheduleExecutions(db, configDAO, runDAO, 100)

    const start = Date.now()
    const count = runDAO.countRunningExecutions()
    const elapsed = Date.now() - start

    expect(count).toBe(0) // all are completed/failed
    expect(elapsed).toBeLessThan(1000) // < 1s
  })

  it('queries delayed executions efficiently', () => {
    seedScheduleExecutions(db, configDAO, runDAO, 500)

    // Seed triggered (not completed) executions on separate schedules — these are "delayed"
    const insertSched = db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES (?, 'perf', ?, '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `)
    const insertDelayed = db.prepare(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, duration_ms, created_at, completed_at, triggered_by
      ) VALUES (?, ?, 'triggered', 'scheduled', ?, '+00:00', 'UTC', 0, ?, NULL, 'scheduler')
    `)
    const pastDate = new Date(Date.now() - 86400_000).toISOString()
    const tx = db.transaction(() => {
      for (let i = 0; i < 10; i++) {
        const schedId = `perf-delayed-sched-${i}`
        insertSched.run(schedId, `delayed-workflow-${i}`)
        insertDelayed.run(`perf-delayed-${i}`, schedId, pastDate, pastDate)
      }
    })
    tx()

    const start = Date.now()
    const delayed = runDAO.findDelayedExecutions(new Date().toISOString())
    const elapsed = Date.now() - start

    expect(delayed.length).toBe(10)
    expect(elapsed).toBeLessThan(5000) // < 5s
  })

  it('memory usage stays within bounds for 1000 workflows', () => {
    const memBefore = process.memoryUsage()
    seedScheduleExecutions(db, configDAO, runDAO, WORKFLOW_COUNT)
    const memAfter = process.memoryUsage()

    const heapUsedMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)
    // Heap growth should be < 500MB for 1000 workflows × 10 executions
    expect(heapUsedMB).toBeLessThan(500)
  })
})
