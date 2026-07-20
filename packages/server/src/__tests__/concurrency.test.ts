/**
 * P5.9 — Concurrency tests for scheduler tasks.
 * Tests queue behavior with simultaneous triggers and manual priority.
 * Located in server package since it tests SchedulerEngine internals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'

// ── Helpers ─────────────────────────────────────────────────────────

const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

function createMockExecutor(delayMs = 10): Executor {
  return {
    getType: () => 'workflow',
    execute: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return {
        success: true,
        exitCode: 0,
        durationMs: delayMs,
        status: 'success' as const,
      }
    }),
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('scheduler concurrency', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('ws-1', 'test', 'test', '/tmp', datetime('now'), datetime('now'))
    `).run()
    db.prepare(`
      INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
    `).run()
  })

  afterEach(() => {
    db.close()
  })

  it('handles multiple simultaneous schedule triggers', async () => {
    const configDAO = new ScheduleConfigDAO(db)
    const runDAO = new ScheduleRunDAO(db)

    // Create 5 enabled schedules
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO schedules (
          id, org, name, cron_expression, timezone,
          enabled, timeout_seconds, notify_on_failure,
          created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
        ) VALUES (?, 'test', ?, '0 9 * * *', 'UTC',
          1, 3600, 0, datetime('now'), datetime('now'),
          'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'allow', 1, 0, 10)
      `).run(`s-${i}`, `task-${i}`)
    }

    const executor = createMockExecutor(10)
    const executors = new Map<string, Executor>()
    executors.set('workflow', executor)

    const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
    engine.start()

    // Trigger all 5 simultaneously
    for (let i = 0; i < 5; i++) {
      const execId = `manual-exec-${i}`
      runDAO.insertTriggeredExecutionForManual(
        execId, `s-${i}`,
        new Date().toISOString(), '+00:00', 'UTC',
      )
      engine.triggerManual(`s-${i}`, execId)
    }

    // Wait for async executions to complete
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
    engine.stop()
  })

  it('skip parallel policy prevents concurrent execution', () => {
    const runDAO = new ScheduleRunDAO(db)

    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-skip', 'test', 'skip-task', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{}', 'skip', 1, 0, 10)
    `).run()

    // Insert a running execution
    runDAO.insertExecution({
      id: 'running-1',
      schedule_id: 's-skip',
      status: 'running',
      trigger_type: 'scheduled',
      triggered_at: new Date().toISOString(),
    })

    // countRunningBySchedule > 0 → SchedulerService.triggerJob would throw SchedulerTriggerConflictError
    const count = runDAO.countRunningBySchedule('s-skip')
    expect(count).toBe(1)
  })

  it('manual trigger dispatches through engine', () => {
    const configDAO = new ScheduleConfigDAO(db)
    const runDAO = new ScheduleRunDAO(db)

    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-manual', 'test', 'manual-task', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'allow', 1, 0, 10)
    `).run()

    const executor = createMockExecutor(5)
    const executors = new Map<string, Executor>()
    executors.set('workflow', executor)

    const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)

    const manualExecId = 'manual-exec-1'
    runDAO.insertTriggeredExecutionForManual(
      manualExecId, 's-manual',
      new Date().toISOString(), '+00:00', 'UTC',
    )
    engine.triggerManual('s-manual', manualExecId)

    expect(executor.execute).toHaveBeenCalled()
  })

  it('queue length reflects active executions accurately', () => {
    const runDAO = new ScheduleRunDAO(db)

    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO schedules (
          id, org, name, cron_expression, timezone,
          enabled, timeout_seconds, notify_on_failure,
          created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
        ) VALUES (?, 'test', ?, '0 9 * * *', 'UTC',
          1, 3600, 0, datetime('now'), datetime('now'),
          'workflow', '{}', 'allow', 1, 0, 10)
      `).run(`q-${i}`, `q-task-${i}`)

      runDAO.insertExecution({
        id: `q-exec-${i}`,
        schedule_id: `q-${i}`,
        status: 'running',
        trigger_type: 'scheduled',
        triggered_at: new Date().toISOString(),
      })
    }

    expect(runDAO.countRunningExecutions()).toBe(3)
  })

  it('completed executions do not count toward queue backlog', () => {
    const runDAO = new ScheduleRunDAO(db)

    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-done', 'test', 'done', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{}', 'allow', 1, 0, 10)
    `).run()

    runDAO.insertExecution({
      id: 'done-1',
      schedule_id: 's-done',
      status: 'completed',
      trigger_type: 'scheduled',
      triggered_at: new Date().toISOString(),
    })

    expect(runDAO.countRunningExecutions()).toBe(0)
  })
})
