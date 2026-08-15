import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { createSchedulerRoutes } from '../routes/scheduler'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import type { SchedulerJob } from '@octopus/shared'

// T-3: 入池 + tick 触发执行
// AC3  - POST /jobs/:id/enqueue 后 status='queued'
// AC7  - queued 任务在 tick 内被 dispatch (execution 行写入)
// AC8  - workspace 命名含 taskpool-{schedule_id}-{ts} 模式

const ORG = 'task-pool-t3'

function makeMockExecutor(): { executor: Executor; calls: Array<{ job: SchedulerJob; executionId: string }> } {
  const calls: Array<{ job: SchedulerJob; executionId: string }> = []
  const executor: Executor = {
    getType: () => 'workflow',
    execute: vi.fn(async (job: SchedulerJob, executionId: string) => {
      calls.push({ job, executionId })
      return {
        success: true,
        exitCode: 0,
        durationMs: 10,
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

describe('T-3: enqueue + tick execution', () => {
  let db: Database.Database
  let app: Hono
  let service: SchedulerService

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)
    service = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(
      service,
      undefined,
      undefined,
    ))
  })

  afterAll(() => {
    db.close()
  })

  async function json<T>(res: Response): Promise<T> {
    return res.json() as Promise<T>
  }

  async function createDraft(name: string): Promise<string> {
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
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: ORG, branch_prefix: 'ai-draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 't3.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string; status: string; trigger_source: string }>(res)
    expect(body.status).toBe('draft')
    expect(body.trigger_source).toBe('requirement')
    return body.id
  }

  // ── AC3: enqueue transitions draft → queued ─────────────────────

  it('AC3: POST /jobs/:id/enqueue transitions draft → queued (status reflected in DB)', async () => {
    const id = await createDraft('t3-ac3')

    const res = await app.request(`/api/scheduler/jobs/${id}/enqueue`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await json<{ status: string }>(res)
    expect(body.status).toBe('queued')

    // 反假跑 AC3: 显式查 DB status 字段, 不只看 API 返回
    const row = db.prepare('SELECT status, trigger_source FROM schedules WHERE id = ?').get(id) as
      { status: string; trigger_source: string }
    expect(row.status).toBe('queued')
    expect(row.trigger_source).toBe('requirement')
  })

  // ── State machine guard: enqueue on non-draft returns 409 ───────

  it('state machine: enqueue on already-queued returns 409', async () => {
    const id = await createDraft('t3-state-machine')
    // First enqueue succeeds
    const r1 = await app.request(`/api/scheduler/jobs/${id}/enqueue`, { method: 'POST' })
    expect(r1.status).toBe(200)
    // Second enqueue fails (queued, not draft)
    const r2 = await app.request(`/api/scheduler/jobs/${id}/enqueue`, { method: 'POST' })
    expect(r2.status).toBe(409)
  })

  // ── trigger_source guard: cron-type can't be enqueued ─────────

  it('trigger_source guard: enqueue on cron-type returns 400', async () => {
    // Create a cron-type schedule
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 't3-cron-type',
        job_type: 'workflow',
        cron_expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        org: ORG,
        config: {
          schema_version: '2.0', type: 'workflow',
          workspace_spec: { org: ORG, branch_prefix: 'cron', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 'c.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const { id } = await json<{ id: string }>(res)

    const r = await app.request(`/api/scheduler/jobs/${id}/enqueue`, { method: 'POST' })
    expect(r.status).toBe(400)
  })

  // ── AC7: checkQueuedTasks pulls queued, claims, dispatches ────

  it('AC7: checkQueuedTasks marks claimed + claimed_at + dispatches via executor', async () => {
    // Use a fresh in-memory DB so the engine has its own state
    const edb = new Database(':memory:')
    applySchema(edb)
    edb.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('t3-ws', 't3ws', '${ORG}', '/tmp', datetime('now'), datetime('now'))
    `).run()
    edb.prepare(`
      INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
    `).run()

    const configDAO = new ScheduleConfigDAO(edb)
    const runDAO = new ScheduleRunDAO(edb)
    const svc = new SchedulerService(configDAO, runDAO)
    const { executor, calls } = makeMockExecutor()
    const executors = new Map<string, Executor>([['workflow', executor]])
    const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
    engine.start()

    // Insert a draft + enqueue it
    const insertRes = edb.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy,
        version, consecutive_failures, max_retain,
        status, trigger_source, source_chat_session_id, claimed_at
      ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', 0, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, 'draft', 'requirement', NULL, NULL)
    `).run('t3-engine-1', ORG, 't3-engine-name', new Date().toISOString(), new Date().toISOString())

    expect(insertRes.changes).toBe(1)

    // Enqueue
    svc.enqueueJob('t3-engine-1')

    // Verify status is queued before tick
    const before = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get('t3-engine-1') as
      { status: string; claimed_at: string | null }
    expect(before.status).toBe('queued')
    expect(before.claimed_at).toBeNull()

    // Trigger the queued-task tick directly (private method via test backdoor)
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()

    // Give async dispatchExecution a chance to call executor
    await new Promise(r => setTimeout(r, 50))

    // 反假跑 AC7: status='claimed' (engine marked it before dispatch) + claimed_at non-null + executor called
    const after = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get('t3-engine-1') as
      { status: string; claimed_at: string | null }
    expect(after.status).toBe('claimed')
    expect(after.claimed_at).not.toBeNull()

    expect(calls.length).toBe(1)
    expect(calls[0].job.id).toBe('t3-engine-1')
    expect(calls[0].job.trigger_source).toBe('requirement')

    // Execution row exists (反假跑 AC7: execution 表有记录, 不是仅 status 改了)
    const execRow = edb.prepare(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running', 'completed', 'success')"
    ).get('t3-engine-1') as { cnt: number }
    expect(execRow.cnt).toBeGreaterThanOrEqual(1)

    engine.stop()
    edb.close()
  })

  // ── AC8: workspace name has taskpool-{schedule_id}-{ts} pattern ──

  it('AC8: WorkflowExecutor uses taskpool-{schedule_id}-{ts} naming for requirement-type (verified via job shape)', async () => {
    // 反假跑 AC8: checkQueuedTasks dispatches with job.trigger_source='requirement' and job.id preserved.
    // WorkflowExecutor computes `taskpool-${schedule.id}-${branchSuffix}` from these inputs (workflow-executor.ts:130).
    // We verify the inputs that drive the naming decision; the string itself is verified end-to-end by T-6 E2E.
    const edb = new Database(':memory:')
    applySchema(edb)
    edb.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('t3-ws8', 't3ws8', '${ORG}', '/tmp', datetime('now'), datetime('now'))
    `).run()
    edb.prepare(`
      INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
    `).run()

    const configDAO = new ScheduleConfigDAO(edb)
    const runDAO = new ScheduleRunDAO(edb)
    const svc = new SchedulerService(configDAO, runDAO)
    const { executor, calls } = makeMockExecutor()
    const executors = new Map<string, Executor>([['workflow', executor]])
    const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
    engine.start()

    const SCHEDULE_ID = 't3-naming-1'
    edb.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy,
        version, consecutive_failures, max_retain,
        status, trigger_source, source_chat_session_id, claimed_at
      ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', 0, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, 'draft', 'requirement', NULL, NULL)
    `).run(SCHEDULE_ID, ORG, 't3-naming-name', new Date().toISOString(), new Date().toISOString())

    svc.enqueueJob(SCHEDULE_ID)
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await new Promise(r => setTimeout(r, 50))

    expect(calls.length).toBe(1)
    expect(calls[0].job.id).toBe(SCHEDULE_ID)
    expect(calls[0].job.trigger_source).toBe('requirement')
    // 反假跑: schedule_id preserved through dispatch, so WorkflowExecutor can form `taskpool-${SCHEDULE_ID}-${ts}`

    engine.stop()
    edb.close()
  })
})
