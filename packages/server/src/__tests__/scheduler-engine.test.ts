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
  it('G6: buildSchedulerJob passes through every ScheduleStatus (not narrowed to queued/claimed)', () => {
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
    // 票03 (ADR-0021): 'draft' is off the union — it was the parked state of a task
    // envelope, and a task owns no schedules row any more.
    const statuses = ['queued', 'claimed', 'running', 'done', 'failed', 'aborted'] as const
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
    // 票03 (ADR-0021): origin_type is off the table (v42). The run-state cols the sweep
    // reads (status/claimed_at) stayed — they belong to the pump, not to a task.
    const baseCols = `id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure, created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain, status, claimed_at`
    const seed = (id: string, status: string) => db
      .prepare(`INSERT INTO schedules (${baseCols}) VALUES (?, 'test', ?, NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'), 'workflow', '{}', 'skip', 1, 0, 10, ?, ?)`)
      .run(id, id, status, old)
    seed('s-failed', 'failed')
    seed('s-aborted', 'aborted')
    // control: claimed + stale → SHOULD roll back to queued (existing behavior)
    seed('s-claimed', 'claimed')

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

  // 票03 删除的 G2「连败 N 次 → 终态 failed」用例：那条提升的条件是 origin_type='task'。
  // 它存在的原因是信封可以被 findQueuedSchedules 无视 enabled 重新领走，于是
  // claimed→stale→queued→再派发 会无限循环；没有队列之后 enabled=0 已经止住一切
  // （见 scheduler-engine.onExecutionComplete 的 G2 注释）。剩下的自动停用由
  // consecutive-failure-tracker 自己的用例覆盖，不再在这里断言不存在的状态。
})
