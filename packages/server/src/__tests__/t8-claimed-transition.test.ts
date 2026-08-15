import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import type { SchedulerJob } from '@octopus/shared'

// T-8: queued → claimed 转换 Owner
// AC16 - checkQueuedTasks 拉取后 status='claimed' + claimed_at 非空
// AC17 - 看板 claimed 列渲染（依赖 T-4，跳过 UI 层，留给 T-6 E2E）

const ORG = 'task-pool-t8'

const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

function makeSyncThrowingExecutor(): Executor {
  return {
    getType: () => 'workflow',
    // ponytail: sync throw propagates up through executeWorkflow → dispatchExecution → checkQueuedTasks try/catch
    execute: vi.fn(() => {
      throw new Error('sync dispatch boom')
    }),
  } as unknown as Executor
}

function makeOkExecutor(calls: Array<{ job: SchedulerJob; executionId: string }>): Executor {
  return {
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
  } as unknown as Executor
}

function insertDraft(db: Database.Database, id: string) {
  db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain,
      status, trigger_source, source_chat_session_id, claimed_at
    ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', 0, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, 'draft', 'requirement', NULL, NULL)
  `).run(id, ORG, `name-${id}`, new Date().toISOString(), new Date().toISOString())
}

function setupEngine(db: Database.Database, executor: Executor) {
  const configDAO = new ScheduleConfigDAO(db)
  const runDAO = new ScheduleRunDAO(db)
  const svc = new SchedulerService(configDAO, runDAO)
  const executors = new Map<string, Executor>([['workflow', executor]])
  const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
  engine.start()
  return { svc, engine, configDAO, runDAO }
}

describe('T-8: queued → claimed transition owner', () => {
  let db: Database.Database

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('t8-ws', 't8ws', '${ORG}', '/tmp', datetime('now'), datetime('now'))
    `).run()
    db.prepare(`
      INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
    `).run()
  })

  afterAll(() => {
    db.close()
  })

  // ── AC16: claimed + claimed_at after checkQueuedTasks ─────────

  it('AC16: checkQueuedTasks sets status=claimed + non-null claimed_at (verified via DB)', async () => {
    const edb = new Database(':memory:')
    applySchema(edb)
    edb.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('t8-ac16-ws', 't8ac16', '${ORG}', '/tmp', datetime('now'), datetime('now'))
    `).run()
    edb.prepare(`INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))`).run()

    const calls: Array<{ job: SchedulerJob; executionId: string }> = []
    const { svc, engine } = setupEngine(edb, makeOkExecutor(calls))

    insertDraft(edb, 't8-ac16-1')
    svc.enqueueJob('t8-ac16-1')

    // Pre-condition: status='queued', claimed_at IS NULL
    const before = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get('t8-ac16-1') as
      { status: string; claimed_at: string | null }
    expect(before.status).toBe('queued')
    expect(before.claimed_at).toBeNull()

    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await new Promise(r => setTimeout(r, 50))

    // 反假跑 AC16: 显式 SELECT status + claimed_at, 不只查 status='running'
    const after = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get('t8-ac16-1') as
      { status: string; claimed_at: string | null }
    expect(after.status).toBe('claimed')
    expect(after.claimed_at).not.toBeNull()
    expect(typeof after.claimed_at).toBe('string')
    // claimed_at 应为 ISO 时间戳
    expect(() => new Date(after.claimed_at as string).getTime()).not.toThrow()
    expect(new Date(after.claimed_at as string).getTime()).toBeGreaterThan(0)

    engine.stop()
    edb.close()
  })

  // ── Failure rollback: sync dispatch throw → rollback to queued ─

  it('failure rollback: sync dispatch throw rolls status back to queued + clears claimed_at', async () => {
    const edb = new Database(':memory:')
    applySchema(edb)
    edb.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('t8-rollback-ws', 't8rb', '${ORG}', '/tmp', datetime('now'), datetime('now'))
    `).run()
    edb.prepare(`INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))`).run()

    const { svc, engine } = setupEngine(edb, makeSyncThrowingExecutor())

    insertDraft(edb, 't8-rollback-1')
    svc.enqueueJob('t8-rollback-1')

    const before = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get('t8-rollback-1') as
      { status: string; claimed_at: string | null }
    expect(before.status).toBe('queued')

    // Run checkQueuedTasks — should claim, attempt dispatch, sync throw, rollback
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await new Promise(r => setTimeout(r, 50))

    // 反假跑: status 真回退 + claimed_at 真清空, 不是停在 claimed
    const after = edb.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get('t8-rollback-1') as
      { status: string; claimed_at: string | null }
    expect(after.status).toBe('queued')
    expect(after.claimed_at).toBeNull()

    engine.stop()
    edb.close()
  })
})
