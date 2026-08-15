import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { createSchedulerRoutes } from '../routes/scheduler'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import type { SchedulerJob } from '@octopus/shared'

// T-5: 崩溃恢复 + 并发隔离
// AC6  - 5 queued → 3 dispatched (MAX_PARALLEL_WORKSPACES=3), 2 stay queued
// AC11 - stale claimed (claimed_at > 10min) → rollback to queued + workspace cleaned

const ORG = 'task-pool-t5'

// ponytail: slow executor keeps execution rows in 'triggered' status so the engine's
// active-count check sees them as in-flight. Real executor does I/O which is naturally slow.
function makeSlowMockExecutor(delayMs = 500): { executor: Executor; calls: Array<{ job: SchedulerJob; executionId: string }> } {
  const calls: Array<{ job: SchedulerJob; executionId: string }> = []
  const executor: Executor = {
    getType: () => 'workflow',
    execute: vi.fn(async (job: SchedulerJob, executionId: string) => {
      calls.push({ job, executionId })
      await new Promise(r => setTimeout(r, delayMs))
      return {
        success: true,
        exitCode: 0,
        durationMs: delayMs,
        status: 'success' as const,
      } satisfies ExecutionResult
    }),
  }
  return { executor, calls }
}

const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

describe('T-5: crash recovery + concurrency cap', () => {
  let db: Database.Database
  let app: Hono
  let service: SchedulerService

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)
    service = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(service, undefined, undefined))
  })

  afterAll(() => {
    db.close()
  })

  async function json<T>(res: Response): Promise<T> {
    return res.json() as Promise<T>
  }

  async function createAndEnqueueDraft(name: string): Promise<string> {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: ORG,
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0', type: 'workflow',
          workspace_spec: { org: ORG, branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 't5.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string }>(res)
    const enqRes = await app.request(`/api/scheduler/jobs/${body.id}/enqueue`, { method: 'POST' })
    expect(enqRes.status).toBe(200)
    return body.id
  }

  function setupEngineWithSlowExecutor() {
    const edb = new Database(':memory:')
    applySchema(edb)
    edb.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('t5-ws', 't5ws', '${ORG}', '/tmp', datetime('now'), datetime('now'))
    `).run()
    edb.prepare(`INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))`).run()

    const configDAO = new ScheduleConfigDAO(edb)
    const runDAO = new ScheduleRunDAO(edb)
    const svc = new SchedulerService(configDAO, runDAO)
    const { executor, calls } = makeSlowMockExecutor()
    const executors = new Map<string, Executor>([['workflow', executor]])
    const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
    engine.start()
    return { edb, configDAO, runDAO, svc, engine, calls }
  }

  function insertClaimedSchedule(db: Database.Database, id: string, claimedAtIso: string): void {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy,
        version, consecutive_failures, max_retain,
        status, trigger_source, source_chat_session_id, claimed_at
      ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', 0, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, 'claimed', 'requirement', NULL, ?)
    `).run(id, ORG, `t5-${id}`, now, now, claimedAtIso)
  }

  function insertScheduleWorkspaceRow(db: Database.Database, id: string, scheduleId: string, status: string): void {
    // schedule_workspaces has FK on workspace_id → workspaces; insert a stub row first
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`ws-${id}`, `ws-${id}`, ORG, '/tmp', new Date().toISOString(), new Date().toISOString())
    db.prepare(`
      INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, scheduleId, `ws-${id}`, status, 'suffix', new Date().toISOString())
  }

  // ── AC6: 5 queued → 3 dispatched, 2 stay queued ────────────────

  it('AC6: 5 queued tasks dispatch only 3 (MAX_PARALLEL_WORKSPACES); 2 remain queued', async () => {
    const { edb, configDAO, runDAO, svc, engine, calls } = setupEngineWithSlowExecutor()

    // Enqueue 5 tasks
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = `t5-ac6-${i}`
      edb.prepare(`
        INSERT INTO schedules (
          id, org, name, cron_expression, timezone,
          enabled, timeout_seconds, notify_on_failure,
          created_at, updated_at, job_type, config, parallel_policy,
          version, consecutive_failures, max_retain,
          status, trigger_source, source_chat_session_id, claimed_at
        ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', 0, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, 'draft', 'requirement', NULL, NULL)
      `).run(id, ORG, `t5-ac6-name-${i}`, new Date().toISOString(), new Date().toISOString())
      svc.enqueueJob(id)
      ids.push(id)
    }

    // Run the queued-task tick directly
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    // Give async dispatch a tick to land execute() calls
    await new Promise(r => setTimeout(r, 30))

    // 反假跑 AC6: 3 真进 claimed + dispatched (executor called 3 times), 2 真保持 queued
    const rows = edb.prepare('SELECT id, status FROM schedules WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids) as
      Array<{ id: string; status: string }>
    const claimed = rows.filter(r => r.status === 'claimed')
    const queued = rows.filter(r => r.status === 'queued')
    expect(claimed.length).toBe(3)
    expect(queued.length).toBe(2)
    expect(calls.length).toBe(3)

    // 反假跑: 前 3 个真有 execution 行 (不是仅 status 改了)
    const execCount = edb.prepare(
      `SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id IN (${ids.map(() => '?').join(',')})`
    ).get(...ids) as { cnt: number }
    expect(execCount.cnt).toBe(3)

    engine.stop()
    edb.close()
  })

  // ── AC11: stale claimed → tick → status='queued' + workspace cleaned ──

  it('AC11: stale claimed (claimed_at 20min ago) rolls back to queued + workspace marked cleaned', async () => {
    const { edb, configDAO, runDAO, engine } = setupEngineWithSlowExecutor()
    // Reuse the engine just to access checkStaleClaimed; no execution happens here.

    const scheduleId = 't5-ac11-stale'
    // 20 minutes ago
    const staleIso = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    insertClaimedSchedule(edb, scheduleId, staleIso)
    insertScheduleWorkspaceRow(edb, 'sw-1', scheduleId, 'running')

    // Run checkStaleClaimed directly
    await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()

    // 反假跑 AC11: status 真回退到 queued (查表), claimed_at 真清空 (不是仅 status 改了)
    const schedRow = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get(scheduleId) as
      { status: string; claimed_at: string | null }
    expect(schedRow.status).toBe('queued')
    expect(schedRow.claimed_at).toBeNull()

    // 反假跑 AC11: workspace 真清理 — schedule_workspaces.status='cleaned' + completed_at 非空
    const swRow = edb.prepare('SELECT status, completed_at FROM schedule_workspaces WHERE id = ?').get('sw-1') as
      { status: string; completed_at: string | null }
    expect(swRow.status).toBe('cleaned')
    expect(swRow.completed_at).not.toBeNull()

    engine.stop()
    edb.close()
  })

  // ── AC11 反假跑: fresh claimed (claimed_at recent) is NOT rolled back ──

  it('AC11 反假跑: fresh claimed (claimed_at 1min ago) is NOT rolled back', async () => {
    const { edb, engine } = setupEngineWithSlowExecutor()

    const scheduleId = 't5-ac11-fresh'
    const freshIso = new Date(Date.now() - 60 * 1000).toISOString() // 1 minute ago
    insertClaimedSchedule(edb, scheduleId, freshIso)

    await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()

    // 反假跑: fresh claimed 不该被回退
    const schedRow = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get(scheduleId) as
      { status: string; claimed_at: string | null }
    expect(schedRow.status).toBe('claimed')
    expect(schedRow.claimed_at).toBe(freshIso)

    engine.stop()
    edb.close()
  })
})
