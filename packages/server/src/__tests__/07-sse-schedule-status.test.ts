import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { SSEService } from '../services/sse'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'

// 07 — SSE 注入 SchedulerEngine + SchedulerService：全转换点 emit
//
// 票03 (ADR-0021) 之后，泵与作业服务**仍然拥有**的转换只剩两条，这个文件也就只剩这两条：
//   checkStaleClaimed 崩溃回滚 → 'queued'  (scheduler-engine)
//   abortJob         用户中止 → 'aborted'  (scheduler-service)
// 删掉的四条各自的主体都不存在了：
//   enqueueJob → 'queued'      —— enqueue 这个动作随信封一起删除（POST /jobs/:id/enqueue 已下线）
//   checkQueuedTasks → 'claimed' / 同步派发失败回滚 → 'queued' —— 领取循环整块删除
//   连败 N 次 → 终态 'failed'   —— 该提升只在 origin_type='task' 上成立（引擎 onExecutionComplete
//                                的注释解释了原因），现在只有 enabled=0 自动停用，无 SSE
// 'running' / 'done' 由执行侧（lifecycle / executor）负责，不在本文件断言（mock executor 不触发）。
//
// 两条都改成「cron 作业」形状：schedules 表已无 origin_* 列，run-state 就是作业自己的。

const ORG = 'task-pool-07'

const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

type SchedStatusEvent = { schedule_id: string; status: string }

/** Real SSEService subscribed to the global 'taskpool' channel. */
function makeSSECollector() {
  const sse = new SSEService()
  const events: SchedStatusEvent[] = []
  sse.subscribe('taskpool', (e) => {
    if (e.event === 'schedule_status') {
      events.push(e.data as SchedStatusEvent)
    }
  })
  return { sse, events }
}

function makeOkExecutor(): Executor {
  return {
    getType: () => 'workflow',
    execute: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      durationMs: 10,
      status: 'success' as const,
    }) satisfies ExecutionResult),
  } as unknown as Executor
}

/** A cron job row parked in the pump's own run-state (status/claimed_at survived v42). */
function insertJob(
  db: Database.Database,
  id: string,
  opts: { status?: string; claimedAt?: string | null; enabled?: number } = {},
): void {
  db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain,
      status, claimed_at
    ) VALUES (?, ?, ?, '0 9 * * *', 'Asia/Shanghai', ?, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, ?, ?)
  `).run(
    id,
    ORG,
    `name-${id}`,
    opts.enabled ?? 1,
    new Date().toISOString(),
    new Date().toISOString(),
    opts.status ?? 'queued',
    opts.claimedAt ?? null,
  )
}

function newDb(): Database.Database {
  const db = new Database(':memory:')
  applySchema(db)
  db.prepare(`
    INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
    VALUES ('ws-07', 'ws07', '${ORG}', '/tmp', datetime('now'), datetime('now'))
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
  `).run()
  return db
}

/** Read schedule status + claimed_at straight from DB (anti-fake-run R3/R4). */
function readSchedule(db: Database.Database, id: string) {
  return db.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get(id) as
    { status: string; claimed_at: string | null }
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe('07: SSE schedule_status emits on the transitions the pump still owns', () => {
  let db: Database.Database

  beforeEach(() => {
    db = newDb()
  })

  afterEach(() => {
    db.close()
  })

  // ── checkStaleClaimed rollback → 'queued' (scheduler-engine) ────────

  it('checkStaleClaimed emits schedule_status queued on stale rollback', async () => {
    const { sse, events } = makeSSECollector()
    const executors = new Map<string, Executor>([['workflow', makeOkExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db),
      mockWorkspaceScheduleService, executors, sse,
    )
    engine.start()

    // A fire whose claimed_at is well past the 10min stale threshold (worker died).
    const staleClaimedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    insertJob(db, '07-stale-1', { status: 'claimed', claimedAt: staleClaimedAt })

    await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()
    await tick()

    // Assert: DB rolled back to queued + claimed_at cleared
    const row = readSchedule(db, '07-stale-1')
    expect(row.status).toBe('queued')
    expect(row.claimed_at).toBeNull()
    // Assert: SSE queued (rollback) — the kanban sees crash recovery without polling
    expect(events).toContainEqual({ schedule_id: '07-stale-1', status: 'queued' })

    engine.stop()
  })

  // ── abortJob → 'aborted' (scheduler-service) ────────────────────────

  it('abortJob emits schedule_status aborted on claimed→aborted', async () => {
    const { sse, events } = makeSSECollector()
    const svc = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), sse)

    insertJob(db, '07-abort-1', { status: 'claimed', claimedAt: new Date().toISOString() })

    await svc.abortJob('07-abort-1')

    // Assert: DB aborted + claimed_at cleared
    const row = readSchedule(db, '07-abort-1')
    expect(row.status).toBe('aborted')
    expect(row.claimed_at).toBeNull()
    // Assert: SSE aborted
    expect(events).toContainEqual({ schedule_id: '07-abort-1', status: 'aborted' })
  })

  it('abortJob emits nothing when the guard refuses (a rolled-back abort is not a transition)', async () => {
    const { sse, events } = makeSSECollector()
    const svc = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db), sse)

    // 'queued' = registered, nothing in flight → not abortable, and crucially the emit
    // sits AFTER the transaction so a refused abort must not move the card.
    insertJob(db, '07-abort-2', { status: 'queued' })

    await expect(svc.abortJob('07-abort-2')).rejects.toThrow(/cannot abort/i)
    expect(events).toEqual([])
    expect(readSchedule(db, '07-abort-2').status).toBe('queued')
  })
})
