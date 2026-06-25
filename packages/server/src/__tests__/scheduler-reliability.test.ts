import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { CircuitBreaker, CircuitBreakerOpenError } from '../services/scheduler/circuit-breaker'
import { Semaphore } from '../services/scheduler/semaphore'
import { ScheduleConfigDAO } from '../db/dao'
import { ConsecutiveFailureTracker } from '../services/scheduler/consecutive-failure-tracker'

describe('Scheduler Reliability', () => {
  // ── CircuitBreaker ──────────────────────────────────────────────

  describe('CircuitBreaker', () => {
    let cb: CircuitBreaker

    beforeEach(() => {
      cb = new CircuitBreaker({
        volumeThreshold: 3,
        errorThresholdPercentage: 50,
        resetTimeoutMs: 100,
      })
    })

    it('starts in closed state', () => {
      expect(cb.getState()).toBe('closed')
    })

    it('stays closed on success', async () => {
      await cb.execute(async () => 'ok')
      expect(cb.getState()).toBe('closed')
    })

    it('transitions to open after threshold errors', async () => {
      const fail = async () => { throw new Error('fail') }

      // 3 failures in a row (50% of 3 = 1.5, so 2+ failures trip it)
      await expect(cb.execute(fail)).rejects.toThrow('fail')
      await expect(cb.execute(fail)).rejects.toThrow('fail')
      expect(cb.getState()).toBe('closed') // 2/3 = 66% but need 50% threshold
      await expect(cb.execute(fail)).rejects.toThrow('fail')
      expect(cb.getState()).toBe('open') // 3/3 = 100%
    })

    it('rejects calls when open', async () => {
      cb = new CircuitBreaker({ volumeThreshold: 1, errorThresholdPercentage: 0, resetTimeoutMs: 1000 })
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()
      expect(cb.getState()).toBe('open')
      await expect(cb.execute(async () => 'ok')).rejects.toThrow(CircuitBreakerOpenError)
    })

    it('transitions to half-open after resetTimeout', async () => {
      cb = new CircuitBreaker({ volumeThreshold: 1, errorThresholdPercentage: 0, resetTimeoutMs: 50 })
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()
      expect(cb.getState()).toBe('open')

      // Wait for resetTimeout
      await new Promise(r => setTimeout(r, 60))

      // Next call should probe (half-open)
      const result = await cb.execute(async () => 'ok')
      expect(result).toBe('ok')
      expect(cb.getState()).toBe('closed')
    })

    it('B2: only allows one probe in half-open', async () => {
      cb = new CircuitBreaker({ volumeThreshold: 1, errorThresholdPercentage: 0, resetTimeoutMs: 10 })
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()

      await new Promise(r => setTimeout(r, 20))

      // First probe: should go through (half-open)
      const probe1 = cb.execute(async () => {
        await new Promise(r => setTimeout(r, 50))
        return 'ok1'
      })

      // Second probe immediately: should be rejected (half-open in-flight)
      await expect(cb.execute(async () => 'ok2')).rejects.toThrow(CircuitBreakerOpenError)

      await probe1
      expect(cb.getState()).toBe('closed')
    })

    it('resets counters on success', async () => {
      cb = new CircuitBreaker({ volumeThreshold: 5, errorThresholdPercentage: 60, resetTimeoutMs: 100 })

      // 2 failures
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()

      // 1 success resets
      await cb.execute(async () => 'ok')
      expect(cb.getState()).toBe('closed')

      // Now 5 failures needed again
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()
      await expect(cb.execute(async () => { throw new Error('x') })).rejects.toThrow()
      expect(cb.getState()).toBe('closed')
    })
  })

  // ── Semaphore ───────────────────────────────────────────────────

  describe('Semaphore', () => {
    it('allows up to maxPermits concurrent acquisitions', async () => {
      const sem = new Semaphore(2)
      await sem.acquire()
      await sem.acquire()
      expect(sem.available).toBe(0)
      sem.release()
      expect(sem.available).toBe(1)
    })

    it('queues when permits exhausted', async () => {
      const sem = new Semaphore(1)
      await sem.acquire()

      let resolved = false
      const queued = sem.acquire().then(() => { resolved = true })

      // Give it a chance to resolve (it shouldn't yet)
      await new Promise(r => setTimeout(r, 10))
      expect(resolved).toBe(false)
      expect(sem.queued).toBe(1)

      sem.release()
      await queued
      expect(resolved).toBe(true)
    })

    it('B3: prevents double release from growing permits unbounded', () => {
      const sem = new Semaphore(1)
      sem.release() // No prior acquire — should be ignored (warn)
      sem.release()
      expect(sem.available).toBe(1) // Should stay at maxPermits, not 3
    })

    it('handles FIFO order for queued acquisitions', async () => {
      const sem = new Semaphore(1)
      await sem.acquire()

      const order: number[] = []
      const p1 = sem.acquire().then(() => order.push(1))
      const p2 = sem.acquire().then(() => order.push(2))

      sem.release() // unblocks p1
      await p1
      sem.release() // unblocks p2
      await p2

      expect(order).toEqual([1, 2])
    })
  })

  // ── ConsecutiveFailureTracker ───────────────────────────────────

  describe('ConsecutiveFailureTracker', () => {
    let db: Database.Database
    let tracker: ConsecutiveFailureTracker

    beforeEach(() => {
      db = new Database(':memory:')
      applySchema(db)
      db.prepare(`
        INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
        VALUES ('ws-1', 'test', 'test', '/tmp', datetime('now'), datetime('now'))
      `).run()
      db.prepare(`
        INSERT INTO schedules (
          id, org, name, cron_expression, timezone,
          enabled, timeout_seconds, notify_on_failure,
          next_trigger_at, created_at, updated_at,
          job_type, config, parallel_policy, version, consecutive_failures, max_retain
        ) VALUES ('s-1', 'test', 'test', '0 9 * * *', 'UTC',
          1, 3600, 0, NULL, datetime('now'), datetime('now'),
          'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
      `).run()
      tracker = new ConsecutiveFailureTracker(new ScheduleConfigDAO(db))
    })

    it('increments failure count', () => {
      tracker.recordFailure('s-1')
      const row = db.prepare('SELECT consecutive_failures FROM schedules WHERE id = ?').get('s-1') as { consecutive_failures: number }
      expect(row.consecutive_failures).toBe(1)
    })

    it('resets on success', () => {
      tracker.recordFailure('s-1')
      tracker.recordFailure('s-1')
      tracker.recordSuccess('s-1')
      const row = db.prepare('SELECT consecutive_failures FROM schedules WHERE id = ?').get('s-1') as { consecutive_failures: number }
      expect(row.consecutive_failures).toBe(0)
    })

    it('auto-disables after 5 consecutive failures', () => {
      for (let i = 0; i < 4; i++) {
        const result = tracker.recordFailure('s-1')
        expect(result.autoDisabled).toBe(false)
      }
      const result = tracker.recordFailure('s-1')
      expect(result.autoDisabled).toBe(true)

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get('s-1') as { enabled: number }
      expect(row.enabled).toBe(0)
    })

    it('B1: recordFailure is atomic (no race between increment and check)', () => {
      // Simulate concurrent failures — all 5 should see correct state
      const results = Array.from({ length: 5 }, () => tracker.recordFailure('s-1'))
      const autoDisabledCount = results.filter(r => r.autoDisabled).length
      // Exactly one should auto-disable (the 5th), not multiple
      expect(autoDisabledCount).toBe(1)
    })
  })
})
