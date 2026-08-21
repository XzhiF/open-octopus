import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import type { SchedulerJob } from '@octopus/shared'

// Mock WorkspaceScheduleService (minimal — only setOnScheduleChange is called by engine)
const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

function createMockExecutor(result: Partial<ExecutionResult> = {}): Executor {
  return {
    getType: () => 'test',
    execute: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      durationMs: 100,
      status: 'success' as const,
      ...result,
    })),
  }
}

describe('SchedulerEngine', () => {
  let db: Database.Database
  const wsId = 'ws-1'

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, 'test', 'test', '/tmp', datetime('now'), datetime('now'))
    `).run(wsId)
    // Ensure scheduler_state row exists (some engine methods touch it)
    db.prepare(`
      INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
    `).run()
  })

  afterEach(() => {
    db.close()
  })

  it('starts and stops cleanly', () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    expect(engine.isRunning()).toBe(false)
    engine.start()
    expect(engine.isRunning()).toBe(true)
    engine.stop()
    expect(engine.isRunning()).toBe(false)
  })

  it('loads enabled schedules on start', () => {
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-1', 'test', 'test', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `).run()

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)
    engine.start()

    expect(engine['cronJobs'].size).toBe(1)
    engine.stop()
  })

  it('reload clears and reloads cron jobs', () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)
    engine.start()
    expect(engine['cronJobs'].size).toBe(0)

    // Add a schedule
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-2', 'test', 'test2', '0 10 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `).run()

    engine.reload()
    expect(engine['cronJobs'].size).toBe(1)
    engine.stop()
  })

  it('triggerManual dispatches via executor', async () => {
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-3', 'test', 'test3', '0 11 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `).run()

    db.prepare(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES ('e-1', 's-3', 'triggered', 'manual', datetime('now'), '+00:00', 'UTC', datetime('now'), 'user')
    `).run()

    const mockExec = createMockExecutor()
    const executors = new Map<string, Executor>()
    executors.set('workflow', mockExec)
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    engine.triggerManual('s-3', 'e-1')

    // Give async dispatch a chance to execute
    await new Promise(r => setTimeout(r, 100))

    expect(mockExec.execute).toHaveBeenCalled()
    expect((mockExec.execute as any).mock.calls[0][1]).toBe('e-1')
  })

  it('triggerManual for non-existent schedule marks execution failed', async () => {
    // Disable FK so we can INSERT execution pointing to non-existent schedule
    db.pragma('foreign_keys = OFF')
    db.prepare(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES ('e-2', 'non-existent', 'triggered', 'manual', datetime('now'), '+00:00', 'UTC', datetime('now'), 'user')
    `).run()

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    engine.triggerManual('non-existent', 'e-2')

    const row = db.prepare('SELECT status, error_summary FROM schedule_executions WHERE id = ?').get('e-2') as { status: string; error_summary: string | null }
    expect(row.status).toBe('failed')
    expect(row.error_summary).toContain('not found')
  })

  it('B6: isDstGap returns false for UTC (no DST)', () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    // UTC has no DST transitions
    expect(engine['isDstGap']('0 9 * * *', 'UTC')).toBe(false)
  })

  it('B6: isDstGap returns false for invalid cron', () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    expect(engine['isDstGap']('invalid cron', 'UTC')).toBe(false)
  })

  it('detects missed executions on start', async () => {    // Schedule that should have fired in the past hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-4', 'test', 'test4', '* * * * *', 'UTC',
        1, 3600, 0, ?, datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `).run(oneHourAgo)

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    engine.start()

    // Give detectMissed a chance to run
    await new Promise(r => setTimeout(r, 200))

    const missedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE status = 'missed'"
    ).get() as { cnt: number }).cnt

    expect(missedCount).toBeGreaterThan(0)

    engine.stop()
  })

  // ── G6 (ticket 05): buildSchedulerJob cast must carry every ScheduleStatus ──
  it('G6: buildSchedulerJob passes through every ScheduleStatus (not narrowed to draft/queued/claimed)', () => {
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-g6', 'test', 'g6', NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"2.0","type":"workflow","workspace_spec":{"org":"t","branch_prefix":"b","projects":[{"name":"p","source_path":"","group":""}]},"workflow_chain":[{"workflow_ref":"w","input_values":{}}]}',
        'skip', 1, 0, 10)
    `).run()

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)
    const configDAO = new ScheduleConfigDAO(db)

    // Every ScheduleStatus literal must flow through unchanged. The old cast
    // (`as 'draft'|'queued'|'claimed'`) lied to TypeScript; the runtime value
    // still passed, so this also guards against a future default-coercion bug.
    const statuses = ['draft', 'queued', 'claimed', 'running', 'done', 'failed', 'aborted'] as const
    for (const status of statuses) {
      configDAO.updateSchedule('s-g6', { status })
      const row = configDAO.findByIdRaw('s-g6')!
      const job = (engine as any).buildSchedulerJob(row) as SchedulerJob
      expect(job.status).toBe(status)
    }
  })

  // ── G2 (ticket 05): failed/aborted are terminal — checkStaleClaimed must NOT roll back ──
  it('G2: checkStaleClaimed does not roll back terminal failed/aborted (prevents infinite re-dispatch)', async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString() // 20 min ago, beyond 10min stale threshold
    // SG1b (ticket 06): trigger_source DROPPED → origin_type ('task' = v1 'requirement')
    const baseCols = `id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure, created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain, status, origin_type, claimed_at`
    // terminal failed
    db.prepare(`INSERT INTO schedules (${baseCols}) VALUES ('s-failed', 'test', 'f', NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'), 'workflow', '{}', 'skip', 1, 0, 10, 'failed', 'task', ?)`).run(old)
    // terminal aborted
    db.prepare(`INSERT INTO schedules (${baseCols}) VALUES ('s-aborted', 'test', 'a', NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'), 'workflow', '{}', 'skip', 1, 0, 10, 'aborted', 'task', ?)`).run(old)
    // control: claimed + stale → SHOULD roll back to queued (existing behavior)
    db.prepare(`INSERT INTO schedules (${baseCols}) VALUES ('s-claimed', 'test', 'c', NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'), 'workflow', '{}', 'skip', 1, 0, 10, 'claimed', 'task', ?)`).run(old)

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    await (engine as any).checkStaleClaimed()

    const failed = db.prepare('SELECT status FROM schedules WHERE id = ?').get('s-failed') as { status: string }
    const aborted = db.prepare('SELECT status FROM schedules WHERE id = ?').get('s-aborted') as { status: string }
    const claimed = db.prepare('SELECT status FROM schedules WHERE id = ?').get('s-claimed') as { status: string }
    expect(failed.status).toBe('failed')   // terminal — NOT rolled back
    expect(aborted.status).toBe('aborted')  // terminal — NOT rolled back
    expect(claimed.status).toBe('queued')   // control — rolled back (existing behavior)
  })

  // ── G2 (ticket 05): retry cap — N consecutive failures promote requirement schedule to terminal 'failed' ──
  it('G2 retry cap: requirement schedule promoted to failed after N consecutive failures (terminal, no re-dispatch)', async () => {
    // One failure shy of the N=5 auto-disable threshold.
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version,
        consecutive_failures, max_retain, status, origin_type, claimed_at
      ) VALUES ('s-retry', 'test', 'retry', NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"2.0","type":"workflow","workspace_spec":{"org":"t","branch_prefix":"b","projects":[{"name":"p","source_path":"","group":""}]},"workflow_chain":[{"workflow_ref":"w","input_values":{}}]}',
        'skip', 1, 4, 10, 'queued', 'task', NULL)
    `).run()

    const failingExecutor: Executor = {
      getType: () => 'workflow',
      execute: vi.fn(async () => ({
        success: false, exitCode: 1, durationMs: 10, status: 'failure' as const, errorMessage: 'boom',
      })),
    }
    const executors = new Map<string, Executor>()
    executors.set('workflow', failingExecutor)
    const engine = new SchedulerEngine(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors)

    // checkQueuedTasks claims (status='claimed') + dispatches → executor fails →
    // onExecutionComplete → recordFailure (5th) → autoDisabled → status='failed'.
    await (engine as any).checkQueuedTasks()
    await new Promise(r => setTimeout(r, 50)) // let executeWorkflow .then(onExecutionComplete) resolve

    const row = db.prepare('SELECT status, enabled, consecutive_failures FROM schedules WHERE id = ?').get('s-retry') as { status: string; enabled: number; consecutive_failures: number }
    expect(row.status).toBe('failed')           // terminal promotion (G2 retry cap)
    expect(row.enabled).toBe(0)                  // auto-disabled (existing tracker)
    expect(row.consecutive_failures).toBe(5)     // threshold reached

    // Terminal: subsequent ticks must NOT re-dispatch or roll back (the G2 loop).
    await (engine as any).checkStaleClaimed()
    await (engine as any).checkQueuedTasks()
    const row2 = db.prepare('SELECT status FROM schedules WHERE id = ?').get('s-retry') as { status: string }
    expect(row2.status).toBe('failed')
  })
})
