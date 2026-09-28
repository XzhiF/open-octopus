import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import DatabaseLib from 'better-sqlite3'
import { Hono } from 'hono'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { createSchedulerRoutes, resetSchedulerRateLimitersForTests } from '../routes/scheduler'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import { describePg, setupPgSchema, type PgFixture } from '../db/pg/__tests__/dao-fixture'
import type { Executor, ExecutionResult } from '../services/scheduler/executors/executor-interface'
import type { SchedulerJob } from '@octopus/shared'

// T-3: 到点触发 → 执行 (cron 版)
//
// 票03 (ADR-0021) 删掉了这条链的前半截：POST /jobs/:id/enqueue（draft→queued）与
// checkQueuedTasks 的领取循环整体不存在了 —— 任务不再以 schedules 行排队，入队的任务由
// 内置 task-lifecycle 作业直接武装成 executions 行（那边由
// services/tasks/__tests__/task-lifecycle.test.ts 覆盖 arm→claim→launch 全链）。
//
// 这里保留的是**作业**的同一件事：到点的那一脚真的写执行行、真的把作业交给 executor、
// 游标真的前移。三条：
//   AC7  - cron 到点 (triggerSchedule) → schedule_executions('triggered','scheduled') + executor 收到
//   AC7-  - enabled=0 → 到点不派发，也不留执行行（负向）
//   AC3  - 手动触发路由 → 执行行 + onTrigger 把作业交给引擎（enqueue 路由下线后的唯一手动入口）
//
// P1 B5 票4：schedules/schedule_executions 已落 PG（B5 票1 DAO 迁移）—— 造数/断言
// 改吃 pg.sql；SQLite 模式下 describePg 门控 skip（计数不减）。

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

const WORKFLOW_CONFIG = JSON.stringify({
  schema_version: '2.0',
  type: 'workflow',
  workspace_spec: { org: ORG, branch_prefix: 't3', projects: [{ name: 'p', source_path: '', group: '' }] },
  workflow_chain: [{ workflow_ref: 't3.yaml', input_values: {} }],
  max_retain: 10,
})

// 本地 SQLite 占位库：仅钉住 schema 不漂移；本域数据面已全部走 PG。
function newLocalSqlite(): Database {
  const db = new DatabaseLib(':memory:')
  applySchema(db)
  return db
}

async function insertJob(
  pg: PgFixture,
  id: string,
  opts: { enabled?: boolean; nextTriggerAt?: string | null } = {},
): Promise<void> {
  await pg.sql.unsafe(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain, status, next_trigger_at
    ) VALUES ($1, $2, $3, '0 9 * * *', 'Asia/Shanghai', $4, 3600, false, now(), now(), 'workflow', $5::jsonb, 'skip', 1, 0, 10, 'queued', $6::timestamptz)`,
    [id, ORG, `name-${id}`, opts.enabled ?? true, WORKFLOW_CONFIG, opts.nextTriggerAt ?? null],
  )
}

let realHome: string | undefined
let realUserProfile: string | undefined
let tmpHome: string

beforeEach(() => {
  // triggerSchedule 会经 getConfigManager(org) 读 safe_mode —— 那是 $HOME/.octopus 下的
  // 文件。指向临时 HOME 让「没有 config.yaml → 默认值」成为确定的前提；存/还原见 afterEach
  // （泄漏 HOME 会让同 worker 里的无关套件在全量跑时偶发红）。
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 't3-home-'))
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  resetSchedulerRateLimitersForTests()
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describePg('T-3: 到点触发 → 执行', () => {
  // ── AC7: cron 到点 → 执行行 + 派发 ──────────────────────────────

  it('AC7: 到点触发写入 triggered 执行行并把作业交给 executor（next_trigger_at 前移）', async () => {
    const pg = await setupPgSchema()
    const db = newLocalSqlite()
    try {
      await insertJob(pg, 't3-cron-1')
      const { executor, calls } = makeMockExecutor()
      const executors = new Map<string, Executor>([['workflow', executor]])
      const engine = new SchedulerEngine(
        new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors,
      )
      await engine.start()

      // 反假跑: 直接走 cron 回调的那条私有路径（等价于 node-cron 到点）
      await (engine as unknown as { triggerSchedule: (id: string) => Promise<void> }).triggerSchedule('t3-cron-1')
      await vi.waitFor(async () => {
        expect(calls.length).toBe(1)
      })

      // 执行行真的落库，且带的是「定时」来源（不是 manual）
      const exec = (await pg.sql<{ status: string; trigger_type: string; triggered_by: string | null }[]>
        `SELECT status, trigger_type, triggered_by FROM schedule_executions WHERE schedule_id = 't3-cron-1'`)[0]!
      expect(exec.status).toBe('triggered')
      expect(exec.trigger_type).toBe('scheduled')
      expect(exec.triggered_by).toBe('scheduler')

      // 反假跑 AC7: executor 真被调用，且拿到的是这条作业（DTO 由 schedules 行组装）
      expect(calls[0].job.id).toBe('t3-cron-1')
      expect(calls[0].job.config).toMatchObject({ type: 'workflow' })

      // 游标前移到未来（否则面板与 missed 检测都会说谎）
      const row = (await pg.sql<{ next_trigger_at: Date | null }[]>
        `SELECT next_trigger_at FROM schedules WHERE id = 't3-cron-1'`)[0]!
      expect(row.next_trigger_at).not.toBeNull()
      expect(new Date(row.next_trigger_at!).getTime() > Date.now()).toBe(true)

      engine.stop()
    } finally {
      db.close()
      await pg.close()
    }
  })

  it('AC7 负向: enabled=0 的作业到点不派发，也不留执行行', async () => {
    const pg = await setupPgSchema()
    const db = newLocalSqlite()
    try {
      await insertJob(pg, 't3-cron-off', { enabled: false })
      const { executor, calls } = makeMockExecutor()
      const executors = new Map<string, Executor>([['workflow', executor]])
      const engine = new SchedulerEngine(
        new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), mockWorkspaceScheduleService, executors,
      )
      await engine.start()

      await (engine as unknown as { triggerSchedule: (id: string) => Promise<void> }).triggerSchedule('t3-cron-off')
      await new Promise((r) => setTimeout(r, 30))

      expect(calls.length).toBe(0)
      const cnt = Number((await pg.sql`SELECT COUNT(*)::int AS c FROM schedule_executions WHERE schedule_id = 't3-cron-off'`)[0]!.c)
      expect(cnt).toBe(0)

      engine.stop()
    } finally {
      db.close()
      await pg.close()
    }
  })

  // ── AC3: 手动触发（enqueue 路由下线后唯一的手动入口）──────────────

  it('AC3: POST /jobs/:id/trigger 写 manual 执行行并经引擎派发', async () => {
    const pg = await setupPgSchema()
    const db = newLocalSqlite()
    try {
      const configDAO = new ScheduleConfigDAO(pg.sql)
      const runDAO = new ScheduleRunDAO(pg.sql)
      const service = new SchedulerService(configDAO, runDAO)
      const { executor, calls } = makeMockExecutor()
      const executors = new Map<string, Executor>([['workflow', executor]])
      const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
      // 路由 → service.triggerJob → onTrigger 回调 → engine.triggerManual：这条线在 index.ts
      // 里接线，测试把它接一遍，证明「手动触发」和「到点触发」共用同一次派发。
      service.setCallbacks({ onTrigger: (id, schedExecId) => engine.triggerManual(id, schedExecId) })
      await engine.start()

      const app = new Hono()
      app.route('/api/scheduler', createSchedulerRoutes(service))

      const created = await app.request('/api/scheduler/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 't3-manual',
          job_type: 'workflow',
          cron_expression: '0 9 * * *',
          timezone: 'Asia/Shanghai',
          org: ORG,
          config: JSON.parse(WORKFLOW_CONFIG),
        }),
      })
      expect(created.status).toBe(201)
      const { id } = await created.json() as { id: string }

      const res = await app.request(`/api/scheduler/jobs/${id}/trigger`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json() as { execution_id: string; status: string; trigger_type: string }
      expect(body.status).toBe('triggered')
      expect(body.trigger_type).toBe('manual')

      await vi.waitFor(async () => {
        expect(calls.map((c) => c.job.id)).toEqual([id])
      })

      // 反假跑: 执行行在 DB 里，且就是响应里那个 id
      const exec = (await pg.sql<{ status: string; trigger_type: string }[]>
        `SELECT status, trigger_type FROM schedule_executions WHERE id = ${body.execution_id}`)[0]!
      expect(exec.trigger_type).toBe('manual')
      expect(['triggered', 'running']).toContain(exec.status)

      engine.stop()
    } finally {
      db.close()
      await pg.close()
    }
  })
})
