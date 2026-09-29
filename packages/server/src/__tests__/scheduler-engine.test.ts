import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applySchema } from '../db/schema'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import { describePg, setupPgSchema, type PgFixture } from '../db/pg/__tests__/dao-fixture'
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

// P1 B5 票4：schedules/schedule_executions 已落 PG（ScheduleConfigDAO/ScheduleRunDAO
// 于 B5 票1 迁 BasePgDAO）。engine 的 pump 读 PG；本文件直造行改走 pg.sql。
// SQLite 模式下 describePg 门控 skip（计数不减）。
describePg('SchedulerEngine (PG)', () => {
  let pg: PgFixture
  const wsId = 'ws-1'

  // 一次性占位：保留 applySchema 引用以钉住 SQLite 侧 schema 不漂移（引擎域仍被 B6 才下线）。
  void applySchema

  async function seedSchedule(id: string, extra: { cron?: string | null; created_at?: string; status?: string; claimed_at?: string | null } = {}): Promise<void> {
    await pg.sql.unsafe(
      `INSERT INTO schedules (
         id, org, name, cron_expression, timezone,
         enabled, timeout_seconds, notify_on_failure,
         created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain, status, claimed_at
       ) VALUES ($1, 'test', $2, $3, 'UTC', true, 3600, false, COALESCE($4::timestamptz, now()), now(),
         'workflow', $5::jsonb, 'skip', 1, 0, 10, COALESCE($6, 'queued'), $7::timestamptz)`,
      [
        id, `n-${id}`, extra.cron === null ? null : (extra.cron ?? '0 9 * * *'), extra.created_at ?? null,
        '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}',
        extra.status ?? null, extra.claimed_at ?? null,
      ],
    )
  }

  async function seedFire(id: string, scheduleId: string, status = 'triggered', triggerType = 'manual'): Promise<void> {
    await pg.sql.unsafe(
      `INSERT INTO schedule_executions (
         id, schedule_id, status, trigger_type, triggered_at,
         timezone_offset, timezone_iana, created_at, triggered_by
       ) VALUES ($1, $2, $3, $4, now(), '+00:00', 'UTC', now(), 'user')`,
      [id, scheduleId, status, triggerType],
    )
  }

  beforeEach(async () => {
    pg = await setupPgSchema()
    await pg.sql.unsafe(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
       VALUES ($1, 'test', 'test', '/tmp', now(), now())`,
      [wsId],
    )
    // scheduler_state 行（engine 心跳/领取路径要读）
    await pg.sql.unsafe(
      `INSERT INTO scheduler_state (id, last_heartbeat) VALUES (1, now()) ON CONFLICT (id) DO NOTHING`,
    )
  })

  afterEach(async () => {
    await pg.close()
  })

  it('starts and stops cleanly', async () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    expect(engine.isRunning()).toBe(false)
    await engine.start()
    expect(engine.isRunning()).toBe(true)
    engine.stop()
    expect(engine.isRunning()).toBe(false)
  })

  it('loads enabled schedules on start', async () => {
    await seedSchedule('s-1', { cron: '0 9 * * *' })

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)
    await engine.start()

    expect(engine['cronJobs'].size).toBe(1)
    engine.stop()
  })

  it('reload clears and reloads cron jobs', async () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)
    await engine.start()
    expect(engine['cronJobs'].size).toBe(0)

    // Add a schedule
    await seedSchedule('s-2', { cron: '0 10 * * *' })

    await engine.reload()
    expect(engine['cronJobs'].size).toBe(1)
    engine.stop()
  })

  it('triggerManual dispatches via executor', async () => {
    await seedSchedule('s-3', { cron: '0 11 * * *' })
    await seedFire('e-1', 's-3')

    const mockExec = createMockExecutor()
    const executors = new Map<string, Executor>()
    executors.set('workflow', mockExec)
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    await engine.triggerManual('s-3', 'e-1')

    expect(mockExec.execute).toHaveBeenCalled()
    expect((mockExec.execute as any).mock.calls[0][1]).toBe('e-1')
  })

  it('triggerManual for non-existent schedule marks execution failed', async () => {
    // PG 的 schedule_executions.schedule_id FK 常驻（无 SQLite 的 pragma 开关可关）——
    // 这条「孤儿 fire 行」形状改为本用例内临时撤 FK（随机测试库，afterAll DROP DATABASE 兜底）。
    await pg.sql`ALTER TABLE schedule_executions DROP CONSTRAINT schedule_executions_schedule_id_fkey`
    await pg.sql.unsafe(
      `INSERT INTO schedule_executions (
         id, schedule_id, status, trigger_type, triggered_at,
         timezone_offset, timezone_iana, created_at, triggered_by
       ) VALUES ('e-2', 'non-existent', 'triggered', 'manual', now(), '+00:00', 'UTC', now(), 'user')`,
    )

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    await engine.triggerManual('non-existent', 'e-2')

    const rows = await pg.sql<{ status: string; error_summary: string | null }[]>`
      SELECT status, error_summary FROM schedule_executions WHERE id = 'e-2'`
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.error_summary).toContain('not found')
  })

  it('B6: isDstGap returns false for UTC (no DST)', () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    // UTC has no DST transitions
    expect(engine['isDstGap']('0 9 * * *', 'UTC')).toBe(false)
  })

  it('B6: isDstGap returns false for invalid cron', () => {
    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    expect(engine['isDstGap']('invalid cron', 'UTC')).toBe(false)
  })

  it('detects missed executions on start', async () => {
    // Schedule that should have fired in the past hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await seedSchedule('s-4', { cron: '* * * * *', created_at: oneHourAgo })

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    await engine.start() // start() 内已 await detectMissed（B5 票2 await 传导后不再靠 tick）

    const missedCount = Number((await pg.sql`
      SELECT COUNT(*)::int AS cnt FROM schedule_executions WHERE status = 'missed'`)[0]!.cnt)

    expect(missedCount).toBeGreaterThan(0)

    engine.stop()
  })

  // ── G6 (ticket 05): buildSchedulerJob cast must carry every ScheduleStatus ──
  it('G6: buildSchedulerJob passes through every ScheduleStatus (not narrowed to queued/claimed)', async () => {
    await pg.sql.unsafe(
      `INSERT INTO schedules (
         id, org, name, cron_expression, timezone,
         enabled, timeout_seconds, notify_on_failure,
         created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
       ) VALUES ('s-g6', 'test', 'g6', NULL, 'UTC', true, 3600, false, now(), now(),
         'workflow', '{"schema_version":"2.0","type":"workflow","workspace_spec":{"org":"t","branch_prefix":"b","projects":[{"name":"p","source_path":"","group":""}]},"workflow_chain":[{"workflow_ref":"w","input_values":{}}]}',
         'skip', 1, 0, 10)`,
    )

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)
    const configDAO = new ScheduleConfigDAO(pg.sql)

    // Every ScheduleStatus literal must flow through unchanged. The old cast
    // (`as 'draft'|'queued'|'claimed'`) lied to TypeScript; the runtime value
    // still passed, so this also guards against a future default-coercion bug.
    // 票03 (ADR-0021): 'draft' is off the union — it was the parked state of a task
    // envelope, and a task owns no schedules row any more.
    const statuses = ['queued', 'claimed', 'running', 'done', 'failed', 'aborted'] as const
    for (const status of statuses) {
      await configDAO.updateSchedule('s-g6', { status })
      const row = (await configDAO.findByIdRaw('s-g6'))!
      const job = (engine as any).buildSchedulerJob(row) as SchedulerJob
      expect(job.status).toBe(status)
    }
  })

  // ── G2 (ticket 05): failed/aborted are terminal — checkStaleClaimed must NOT roll back ──
  it('G2: checkStaleClaimed does not roll back terminal failed/aborted (prevents infinite re-dispatch)', async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString() // 20 min ago, beyond 10min stale threshold
    // 票03 (ADR-0021): origin_type is off the table (v42). The run-state cols the sweep
    // reads (status/claimed_at) stayed — they belong to the pump, not to a task.
    const seed = async (id: string, status: string) =>
      seedSchedule(id, { cron: null, status, claimed_at: old, created_at: old })
    await seed('s-failed', 'failed')
    await seed('s-aborted', 'aborted')
    // control: claimed + stale → SHOULD roll back to queued (existing behavior)
    await seed('s-claimed', 'claimed')

    const executors = new Map<string, Executor>()
    executors.set('workflow', createMockExecutor())
    const engine = new SchedulerEngine(new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors)

    await (engine as any).checkStaleClaimed()

    const statusOf = async (id: string) =>
      (await pg.sql<{ status: string }[]>`SELECT status FROM schedules WHERE id = ${id}`)[0]!.status
    expect(await statusOf('s-failed')).toBe('failed')   // terminal — NOT rolled back
    expect(await statusOf('s-aborted')).toBe('aborted') // terminal — NOT rolled back
    expect(await statusOf('s-claimed')).toBe('queued')  // control — rolled back (existing behavior)
  })

  // 票03 删除的 G2「连败 N 次 → 终态 failed」用例：那条提升的条件是 origin_type='task'。
  // 它存在的原因是信封可以被 findQueuedSchedules 无视 enabled 重新领走，于是
  // claimed→stale→queued→再派发 会无限循环；没有队列之后 enabled=0 已经止住一切
  // （见 scheduler-engine.onExecutionComplete 的 G2 注释）。剩下的自动停用由
  // consecutive-failure-tracker 自己的用例覆盖，不再在这里断言不存在的状态。
})
