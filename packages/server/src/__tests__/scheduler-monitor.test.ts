/**
 * SchedulerMonitor Unit Tests (P5.7)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import { SchedulerMonitor } from '../services/monitoring/scheduler-monitor'

describe('SchedulerMonitor', () => {
  let db: Database.Database
  let configDAO: ScheduleConfigDAO
  let runDAO: ScheduleRunDAO
  let monitor: SchedulerMonitor

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    configDAO = new ScheduleConfigDAO(db)
    runDAO = new ScheduleRunDAO(db)
    monitor = new SchedulerMonitor(configDAO, runDAO)
  })

  afterEach(() => {
    db.close()
  })

  function insertSchedule(id: string): void {
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES (?, 'test', ?, '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{}', 'allow', 1, 0, 10)
    `).run(id, id)
  }

  describe('checkQueueBacklog', () => {
    it('returns no alert when queue is empty', () => {
      const result = monitor.checkQueueBacklog()
      expect(result.alert).toBe(false)
      expect(result.queueLength).toBe(0)
    })

    it('alerts when queue exceeds threshold', () => {
      for (let i = 0; i < 10; i++) {
        insertSchedule(`q-${i}`)
        runDAO.insertExecution({
          id: `exec-${i}`,
          schedule_id: `q-${i}`,
          status: 'running',
          trigger_type: 'scheduled',
          triggered_at: new Date().toISOString(),
        })
      }

      const result = monitor.checkQueueBacklog(8)
      expect(result.alert).toBe(true)
      expect(result.queueLength).toBe(10)
    })

    it('does not alert when queue is within threshold', () => {
      for (let i = 0; i < 5; i++) {
        insertSchedule(`q-${i}`)
        runDAO.insertExecution({
          id: `exec-${i}`,
          schedule_id: `q-${i}`,
          status: 'running',
          trigger_type: 'scheduled',
          triggered_at: new Date().toISOString(),
        })
      }

      const result = monitor.checkQueueBacklog(8)
      expect(result.alert).toBe(false)
      expect(result.queueLength).toBe(5)
    })
  })

  describe('checkExecutionDelay', () => {
    it('returns no alert when no delayed jobs', () => {
      const result = monitor.checkExecutionDelay(300_000)
      expect(result.alert).toBe(false)
      expect(result.delayedJobs).toEqual([])
    })

    it('alerts when executions are delayed beyond threshold', () => {
      insertSchedule('delayed-1')
      // Insert execution triggered 10 minutes ago
      runDAO.insertExecution({
        id: 'delayed-exec-1',
        schedule_id: 'delayed-1',
        status: 'running',
        trigger_type: 'scheduled',
        triggered_at: new Date(Date.now() - 600_000).toISOString(),
      })

      const result = monitor.checkExecutionDelay(300_000)
      expect(result.alert).toBe(true)
      expect(result.delayedJobs).toContain('delayed-1')
    })
  })

  describe('checkFailureRate', () => {
    it('returns no alert when failure rate is low', () => {
      insertSchedule('healthy-1')
      for (let i = 0; i < 10; i++) {
        const status = i < 2 ? 'failed' : 'completed'
        db.prepare(`
          INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at, completed_at)
          VALUES (?, 'healthy-1', ?, 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), datetime('now'))
        `).run(`fr-${i}`, status)
      }

      const result = monitor.checkFailureRate(0.5, 7)
      expect(result.alert).toBe(false)
    })

    it('alerts when failure rate exceeds threshold', () => {
      insertSchedule('failing-1')
      for (let i = 0; i < 10; i++) {
        const status = i < 7 ? 'failed' : 'completed'
        db.prepare(`
          INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at, completed_at)
          VALUES (?, 'failing-1', ?, 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), datetime('now'))
        `).run(`fr2-${i}`, status)
      }

      const result = monitor.checkFailureRate(0.5, 7)
      expect(result.alert).toBe(true)
      expect(result.highFailureWorkflows).toHaveLength(1)
      expect(result.highFailureWorkflows[0].id).toBe('failing-1')
      expect(result.highFailureWorkflows[0].rate).toBeGreaterThan(0.5)
    })
  })

  describe('runAllChecks', () => {
    it('returns aggregate report with no alerts on clean state', () => {
      const report = monitor.runAllChecks()
      expect(report.anyAlert).toBe(false)
      expect(report.queueBacklog.alert).toBe(false)
      expect(report.executionDelay.alert).toBe(false)
      expect(report.failureRate.alert).toBe(false)
      expect(report.timestamp).toBeDefined()
    })

    it('flags anyAlert when at least one check alerts', () => {
      // Create backlog
      for (let i = 0; i < 10; i++) {
        insertSchedule(`all-${i}`)
        runDAO.insertExecution({
          id: `all-exec-${i}`,
          schedule_id: `all-${i}`,
          status: 'running',
          trigger_type: 'scheduled',
          triggered_at: new Date().toISOString(),
        })
      }

      const report = monitor.runAllChecks({ maxQueue: 5 })
      expect(report.anyAlert).toBe(true)
      expect(report.queueBacklog.alert).toBe(true)
    })
  })
})
