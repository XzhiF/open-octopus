import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import { describePg, setupPgSchema, type PgFixture } from '../db/pg/__tests__/dao-fixture'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'

// T-5: 崩溃恢复 —— 泵的滞留回收（cron 作业版）
//
// 票03 (ADR-0021) 砍掉了这个文件的一半：
//   AC6「5 queued → 3 dispatched，2 留 queued」的主体（队列领取 + 名额分配）整块不在了。
//     并发闸现在有两个真正的主人，且都已被别处钉住：作业 fire 由 WorkflowExecutor 用
//     runDAO.countActiveWork() 拦（skip → createSkippedExecution），任务行由内置
//     task-lifecycle 作业的 launchQueued() 排队（services/tasks/__tests__/task-lifecycle.test.ts
//     的「never launches past the shared cap」）；计量口径本身在
//     db/dao/__tests__/count-active-work.test.ts。这里不再重复一份。
//   AC11（保留）：claimed/running 超阈值 → 回滚 queued + claimed_at 清空 + 孤儿执行行改
//     failed（松开 schedule_executions 的 partial UNIQUE，否则下次派发插不进去）+
//     schedule_workspaces 标 cleaned。这条与 origin 无关，泵自己的 run-state 语义照旧。
// 另加：超时回收（checkTimeouts）此前没有任何用例，而同属「回收滞留」这一职责。
//
// 注意：schedules.status/claimed_at 在 v42 后**没有生产方**了（见报告），所以这几条按
// 「给定一个 claimed/running 且 claim 已过期的行，扫描逻辑怎么做」来断言 —— 这是该职责
// 本身，不是对上游写入时序的假设。
//
// P1 B5 票4：schedules/schedule_executions/schedule_workspaces 已落 PG（B5 票1）——
// 造数与断言改吃 pg.sql；claimed_at 断言用 DAO 同款 UTC ISO 投影。

const ORG = 'task-pool-t5'

function makeOkExecutor(): Executor {
  return {
    getType: () => 'workflow',
    execute: vi.fn(async () => ({
      success: true, exitCode: 0, durationMs: 10, status: 'success' as const,
    }) satisfies ExecutionResult),
  } as unknown as Executor
}

const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

/** A job row sitting in the pump's own run-state (status + claimed_at). */
async function insertClaimedSchedule(
  pg: PgFixture,
  id: string,
  claimedAtIso: string,
  status: 'claimed' | 'running' = 'claimed',
): Promise<void> {
  await pg.sql.unsafe(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain,
      status, claimed_at
    ) VALUES ($1, $2, $3, '0 9 * * *', 'Asia/Shanghai', true, 3600, false, now(), now(), 'workflow', '{}'::jsonb, 'skip', 1, 0, 10, $4, $5::timestamptz)`,
    [id, ORG, `t5-${id}`, status, claimedAtIso],
  )
}

async function insertScheduleExecution(
  pg: PgFixture,
  id: string,
  scheduleId: string,
  status: 'triggered' | 'running',
  triggeredAtIso: string,
): Promise<void> {
  await pg.sql.unsafe(`
    INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
      timezone_offset, timezone_iana, created_at)
    VALUES ($1, $2, $3, 'scheduled', $4, '+00:00', 'UTC', $4)`,
    [id, scheduleId, status, triggeredAtIso],
  )
}

async function insertScheduleWorkspaceRow(pg: PgFixture, id: string, scheduleId: string, status: string): Promise<void> {
  // schedule_workspaces has FK on workspace_id → workspaces; insert a stub row first
  await pg.sql.unsafe(`
    INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
    VALUES ($1, $1, $2, '/tmp', now(), now())`,
    [`ws-${id}`, ORG],
  )
  await pg.sql.unsafe(`
    INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at)
    VALUES ($1, $2, $3, $4, 'suffix', now())`,
    [id, scheduleId, `ws-${id}`, status],
  )
}

async function makeEngine(pg: PgFixture): Promise<SchedulerEngine> {
  const engine = new SchedulerEngine(
    new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql),
    mockWorkspaceScheduleService,
    new Map<string, Executor>([['workflow', makeOkExecutor()]]),
  )
  await engine.start()
  return engine
}

async function schedStatus(pg: PgFixture, id: string) {
  const rows = await pg.sql<{ status: string; claimed_at: string | null }[]>`
    SELECT status,
           to_char(claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS claimed_at
    FROM schedules WHERE id = ${id}`
  return rows[0]!
}

async function fireStatus(pg: PgFixture, id: string) {
  const rows = await pg.sql<{ status: string; error_summary: string | null }[]>`
    SELECT status, error_summary FROM schedule_executions WHERE id = ${id}`
  return rows[0]!
}

let realHome: string | undefined
let realUserProfile: string | undefined
let tmpHome: string

beforeEach(() => {
  // 引擎的辅助 tick 会经 getConfigManager() 读 $HOME/.octopus；存/还原，别把临时 HOME
  // 漏给同 worker 的其他文件（全量跑时才红的隔离问题最难查）。
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 't5-home-'))
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describePg('T-5: 崩溃后的 stale 回收', () => {
  // ── AC11: stale claimed → status='queued' + workspace cleaned ──

  it('AC11: stale claimed (claimed_at 20min 前) 回滚 queued + claimed_at 清空 + workspace 标 cleaned', async () => {
    const pg = await setupPgSchema()
    try {
      const engine = await makeEngine(pg)

      const scheduleId = 't5-ac11-stale'
      const staleIso = new Date(Date.now() - 20 * 60 * 1000).toISOString() // 20 min ago
      await insertClaimedSchedule(pg, scheduleId, staleIso)
      await insertScheduleWorkspaceRow(pg, 'sw-1', scheduleId, 'running')

      await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()

      // 反假跑 AC11: status 真回退到 queued (查表), claimed_at 真清空 (不是仅 status 改了)
      const schedRow = await schedStatus(pg, scheduleId)
      expect(schedRow.status).toBe('queued')
      expect(schedRow.claimed_at).toBeNull()

      // 反假跑 AC11: workspace 真清理 — schedule_workspaces.status='cleaned' + completed_at 非空
      const swRow = (await pg.sql<{ status: string; completed_at: Date | null }[]>
        `SELECT status, completed_at FROM schedule_workspaces WHERE id = 'sw-1'`)[0]!
      expect(swRow.status).toBe('cleaned')
      expect(swRow.completed_at).not.toBeNull()

      engine.stop()
    } finally {
      await pg.close()
    }
  })

  it('AC11+: 崩溃在派发确认之后（status=running）同样回滚 —— findStaleClaimed 匹配 claimed 与 running', async () => {
    // story-walker #1: 查询原来只匹配 status='claimed'，于是崩溃在 running 的行永远滞留。
    const pg = await setupPgSchema()
    try {
      const engine = await makeEngine(pg)
      const scheduleId = 't5-running-stale'
      await insertClaimedSchedule(pg, scheduleId, new Date(Date.now() - 20 * 60 * 1000).toISOString(), 'running')

      await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()

      const row = await schedStatus(pg, scheduleId)
      expect(row.status).toBe('queued')
      expect(row.claimed_at).toBeNull()

      engine.stop()
    } finally {
      await pg.close()
    }
  })

  it('AC11+: 回滚同时把孤儿执行行改 failed —— 松开 partial UNIQUE，下一次派发才插得进去', async () => {
    const pg = await setupPgSchema()
    try {
      const engine = await makeEngine(pg)
      const scheduleId = 't5-ac11-orphan-exec'
      const staleIso = new Date(Date.now() - 20 * 60 * 1000).toISOString()
      await insertClaimedSchedule(pg, scheduleId, staleIso)
      await insertScheduleExecution(pg, 'se-orphan', scheduleId, 'running', staleIso)

      await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()

      const exec = await fireStatus(pg, 'se-orphan')
      expect(exec.status).toBe('failed')
      expect(exec.error_summary).toMatch(/stale/i)

      // 反假跑: UNIQUE 真的松了 —— 再插一条 triggered 不冲突
      await expect(insertScheduleExecution(
        pg, 'se-next', scheduleId, 'triggered', new Date().toISOString(),
      )).resolves.toBeUndefined()

      engine.stop()
    } finally {
      await pg.close()
    }
  })

  // ── AC11 反假跑: fresh claimed (claimed_at recent) is NOT rolled back ──

  it('AC11 反假跑: fresh claimed (claimed_at 1min 前) 不回退', async () => {
    const pg = await setupPgSchema()
    try {
      const engine = await makeEngine(pg)

      const scheduleId = 't5-ac11-fresh'
      const freshIso = new Date(Date.now() - 60 * 1000).toISOString() // 1 minute ago
      await insertClaimedSchedule(pg, scheduleId, freshIso)

      await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()

      // 反假跑: fresh claimed 不该被回退（否则一次慢启动会被自己判定为崩溃）
      const schedRow = await schedStatus(pg, scheduleId)
      expect(schedRow.status).toBe('claimed')
      expect(schedRow.claimed_at).toBe(freshIso)

      engine.stop()
    } finally {
      await pg.close()
    }
  })
})

describePg('T-5: 超时回收（同属「回收滞留」，此前无用例）', () => {
  it('running 执行行超过 timeout_seconds → failed 并写明超时；未到点的不动', async () => {
    const pg = await setupPgSchema()
    try {
      // 两条作业各挂一条 running（同一 schedule 只能有一条 active ——
      // idx_sched_execs_unique_active），一条 2 小时前（超 3600s），一条 5 分钟前（未超）。
      await insertClaimedSchedule(pg, 't5-to-old', new Date().toISOString(), 'running')
      await insertClaimedSchedule(pg, 't5-to-young', new Date().toISOString(), 'running')
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      const young = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      await insertScheduleExecution(pg, 'se-old', 't5-to-old', 'running', old)
      await insertScheduleExecution(pg, 'se-young', 't5-to-young', 'running', young)

      const engine = await makeEngine(pg)
      await (engine as unknown as { checkTimeouts: () => Promise<void> }).checkTimeouts()

      const aged = await fireStatus(pg, 'se-old')
      expect(aged.status).toBe('failed')
      expect(aged.error_summary).toMatch(/超时/)
      expect(await fireStatus(pg, 'se-young')).toMatchObject({ status: 'running' })

      engine.stop()
    } finally {
      await pg.close()
    }
  })

  it('agent 作业超时记 timeout（不是 failed），与 workflow 分叉', async () => {
    const pg = await setupPgSchema()
    try {
      await pg.sql.unsafe(`
        INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, timeout_seconds,
          notify_on_failure, created_at, updated_at, job_type, config, parallel_policy, version,
          consecutive_failures, max_retain, status)
        VALUES ('t5-to-agent', $1, 'agent job', '0 9 * * *', 'Asia/Shanghai', true, 3600, false, now(), now(), 'agent', '{}'::jsonb, 'skip', 1, 0, 10, 'queued')`,
        [ORG],
      )
      await insertScheduleExecution(pg, 'se-agent', 't5-to-agent', 'running',
        new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())

      const engine = await makeEngine(pg)
      await (engine as unknown as { checkTimeouts: () => Promise<void> }).checkTimeouts()

      expect(await fireStatus(pg, 'se-agent')).toMatchObject({ status: 'timeout' })

      engine.stop()
    } finally {
      await pg.close()
    }
  })
})
