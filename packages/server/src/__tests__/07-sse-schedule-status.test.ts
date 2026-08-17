import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { SSEService } from '../services/sse'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import type { SchedulerJob } from '@octopus/shared'

// 07 — SSE 注入 SchedulerEngine + 全转换点 emit
//
// Scope: scheduler-engine.ts + scheduler-service.ts emit 'schedule_status' on
// every lifecycle transition they own:
//   enqueueJob      → 'queued'   (scheduler-service)
//   checkQueuedTasks claim  → 'claimed' (scheduler-engine)
//   checkQueuedTasks rollback (sync throw) → 'queued'
//   checkStaleClaimed rollback → 'queued'  (scheduler-engine)
//   abortJob        → 'aborted'  (scheduler-service)
//   onExecutionComplete retry-cap → 'failed' (scheduler-engine; 05 deferred to 07)
//
// 'running' / 'done' / 'failed'(during-exec) are emitted by WorkflowExecutor
// (ticket 05, workflow-executor.ts:257/360/397) — verified by reading, NOT
// asserted here (a mock executor is used, so those code paths don't fire).

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

function makeFailingExecutor(): Executor {
  return {
    getType: () => 'workflow',
    execute: vi.fn(async () => ({
      success: false,
      exitCode: 1,
      durationMs: 10,
      status: 'failure' as const,
      errorMessage: 'boom',
    }) satisfies ExecutionResult),
  } as unknown as Executor
}

function makeSyncThrowingExecutor(): Executor {
  return {
    getType: () => 'workflow',
    // sync throw propagates through executeWorkflow → checkQueuedTasks try/catch
    execute: vi.fn(() => {
      throw new Error('sync dispatch boom')
    }),
  } as unknown as Executor
}

interface InsertOpts {
  enabled?: number
  consecutiveFailures?: number
  status?: string
  claimedAt?: string | null
}

function insertRequirementSchedule(
  db: Database.Database,
  id: string,
  opts: InsertOpts = {},
): void {
  db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain,
      status, trigger_source, source_chat_session_id, claimed_at
    ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', ?, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, ?, 10, ?, 'requirement', NULL, ?)
  `).run(
    id,
    ORG,
    `name-${id}`,
    opts.enabled ?? 0,
    new Date().toISOString(),
    new Date().toISOString(),
    opts.consecutiveFailures ?? 0,
    opts.status ?? 'draft',
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

describe('07: SSE schedule_status emits on all lifecycle transitions', () => {
  let db: Database.Database

  beforeAll(() => {
    db = newDb()
  })

  afterAll(() => {
    db.close()
  })

  // ── enqueueJob → 'queued' (scheduler-service) ───────────────────────

  it('enqueueJob emits schedule_status queued on draft→queued', () => {
    const edb = newDb()
    const { sse, events } = makeSSECollector()
    const svc = new SchedulerService(new ScheduleConfigDAO(edb), new ScheduleRunDAO(edb), sse)

    insertRequirementSchedule(edb, '07-enq-1', { status: 'draft' })

    // Act: draft → queued
    svc.enqueueJob('07-enq-1')

    // Assert: DB transitioned (anti-fake-run)
    expect(readSchedule(edb, '07-enq-1').status).toBe('queued')
    // Assert: SSE schedule_status queued emitted on the taskpool channel
    expect(events).toContainEqual({ schedule_id: '07-enq-1', status: 'queued' })

    edb.close()
  })

  // ── checkQueuedTasks claim → 'claimed' (scheduler-engine) ───────────

  it('checkQueuedTasks emits schedule_status claimed on queued→claimed', async () => {
    const edb = newDb()
    const { sse, events } = makeSSECollector()
    const executors = new Map<string, Executor>([['workflow', makeOkExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(edb), new ScheduleRunDAO(edb),
      mockWorkspaceScheduleService, executors, sse,
    )
    engine.start()

    insertRequirementSchedule(edb, '07-claim-1', { status: 'queued' })

    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick()

    // Assert: DB claimed + claimed_at set
    const row = readSchedule(edb, '07-claim-1')
    expect(row.status).toBe('claimed')
    expect(row.claimed_at).not.toBeNull()
    // Assert: SSE claimed
    expect(events).toContainEqual({ schedule_id: '07-claim-1', status: 'claimed' })

    engine.stop()
    edb.close()
  })

  // ── checkQueuedTasks sync-failure rollback → 'queued' (scheduler-engine) ─

  it('checkQueuedTasks emits schedule_status queued on sync-dispatch rollback', async () => {
    const edb = newDb()
    const { sse, events } = makeSSECollector()
    const executors = new Map<string, Executor>([['workflow', makeSyncThrowingExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(edb), new ScheduleRunDAO(edb),
      mockWorkspaceScheduleService, executors, sse,
    )
    engine.start()

    insertRequirementSchedule(edb, '07-rb-1', { status: 'queued' })

    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick()

    // Assert: DB rolled back to queued + claimed_at cleared
    const row = readSchedule(edb, '07-rb-1')
    expect(row.status).toBe('queued')
    expect(row.claimed_at).toBeNull()
    // Assert: SSE claimed (pre-rollback) then queued (rollback) — both transitions
    expect(events).toContainEqual({ schedule_id: '07-rb-1', status: 'claimed' })
    expect(events).toContainEqual({ schedule_id: '07-rb-1', status: 'queued' })
    // Order: claimed before queued
    const statuses = events
      .filter((e) => e.schedule_id === '07-rb-1')
      .map((e) => e.status)
    expect(statuses.indexOf('claimed')).toBeLessThan(statuses.indexOf('queued'))

    engine.stop()
    edb.close()
  })

  // ── checkStaleClaimed rollback → 'queued' (scheduler-engine) ────────

  it('checkStaleClaimed emits schedule_status queued on stale rollback', async () => {
    const edb = newDb()
    const { sse, events } = makeSSECollector()
    const executors = new Map<string, Executor>([['workflow', makeOkExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(edb), new ScheduleRunDAO(edb),
      mockWorkspaceScheduleService, executors, sse,
    )
    engine.start()

    // Insert a stale claimed schedule (claimed_at well past the 10min threshold)
    const staleClaimedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    insertRequirementSchedule(edb, '07-stale-1', {
      status: 'claimed', claimedAt: staleClaimedAt, enabled: 0,
    })

    await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()
    await tick()

    // Assert: DB rolled back to queued + claimed_at cleared
    const row = readSchedule(edb, '07-stale-1')
    expect(row.status).toBe('queued')
    expect(row.claimed_at).toBeNull()
    // Assert: SSE queued (rollback)
    expect(events).toContainEqual({ schedule_id: '07-stale-1', status: 'queued' })

    engine.stop()
    edb.close()
  })

  // ── abortJob → 'aborted' (scheduler-service) ────────────────────────

  it('abortJob emits schedule_status aborted on claimed→aborted', async () => {
    const edb = newDb()
    const { sse, events } = makeSSECollector()
    const svc = new SchedulerService(new ScheduleConfigDAO(edb), new ScheduleRunDAO(edb), sse)

    insertRequirementSchedule(edb, '07-abort-1', {
      status: 'claimed', claimedAt: new Date().toISOString(), enabled: 0,
    })

    await svc.abortJob('07-abort-1')

    // Assert: DB aborted + claimed_at cleared
    const row = readSchedule(edb, '07-abort-1')
    expect(row.status).toBe('aborted')
    expect(row.claimed_at).toBeNull()
    // Assert: SSE aborted
    expect(events).toContainEqual({ schedule_id: '07-abort-1', status: 'aborted' })

    edb.close()
  })

  // ── onExecutionComplete retry-cap → 'failed' (scheduler-engine; 05 deferred) ─

  it('onExecutionComplete retry-cap emits schedule_status failed on N=5 consecutive failures', async () => {
    const edb = newDb()
    const { sse, events } = makeSSECollector()
    const executors = new Map<string, Executor>([['workflow', makeFailingExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(edb), new ScheduleRunDAO(edb),
      mockWorkspaceScheduleService, executors, sse,
    )
    engine.start()

    // Requirement schedule one failure short of the N=5 auto-disable threshold.
    // enabled=1 so ConsecutiveFailureTracker.recordFailure can flip autoDisabled
    // (tracker requires enabled===1). status='queued' so checkQueuedTasks claims+dispatches.
    insertRequirementSchedule(edb, '07-fail-1', {
      status: 'queued', enabled: 1, consecutiveFailures: 4,
    })

    // checkQueuedTasks claims (emit 'claimed') then dispatches via the failing
    // executor → onExecutionComplete(!success) → recordFailure → 5th failure →
    // autoDisabled=true → retry-cap block writes status='failed' + emits 'failed'.
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick(100)

    // Assert: DB promoted to terminal 'failed' (claimed_at cleared)
    const row = readSchedule(edb, '07-fail-1')
    expect(row.status).toBe('failed')
    expect(row.claimed_at).toBeNull()
    // Assert: SSE claimed then failed
    expect(events).toContainEqual({ schedule_id: '07-fail-1', status: 'claimed' })
    expect(events).toContainEqual({ schedule_id: '07-fail-1', status: 'failed' })

    engine.stop()
    edb.close()
  })
})
