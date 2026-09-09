import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { SchedulerEngine } from '../services/scheduler/scheduler-engine'
import { createSchedulerRoutes, resetSchedulerRateLimitersForTests } from '../routes/scheduler'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
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

function newDb(): Database.Database {
  const db = new Database(':memory:')
  applySchema(db)
  db.prepare(`
    INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
  `).run()
  return db
}

function insertJob(
  db: Database.Database,
  id: string,
  opts: { enabled?: number; nextTriggerAt?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain, status, next_trigger_at
    ) VALUES (?, ?, ?, '0 9 * * *', 'Asia/Shanghai', ?, 3600, 0, ?, ?, 'workflow', ?, 'skip', 1, 0, 10, 'queued', ?)
  `).run(
    id, ORG, `name-${id}`, opts.enabled ?? 1,
    new Date().toISOString(), new Date().toISOString(), WORKFLOW_CONFIG,
    opts.nextTriggerAt ?? null,
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

describe('T-3: 到点触发 → 执行', () => {
  // ── AC7: cron 到点 → 执行行 + 派发 ──────────────────────────────

  it('AC7: 到点触发写入 triggered 执行行并把作业交给 executor（next_trigger_at 前移）', async () => {
    const db = newDb()
    insertJob(db, 't3-cron-1')
    const { executor, calls } = makeMockExecutor()
    const executors = new Map<string, Executor>([['workflow', executor]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors,
    )
    engine.start()

    // 反假跑: 直接走 cron 回调的那条私有路径（等价于 node-cron 到点）
    await (engine as unknown as { triggerSchedule: (id: string) => void }).triggerSchedule('t3-cron-1')
    await new Promise((r) => setTimeout(r, 50))

    // 执行行真的落库，且带的是「定时」来源（不是 manual）
    const exec = db.prepare(
      'SELECT status, trigger_type, triggered_by FROM schedule_executions WHERE schedule_id = ?',
    ).get('t3-cron-1') as { status: string; trigger_type: string; triggered_by: string | null }
    expect(exec.status).toBe('triggered')
    expect(exec.trigger_type).toBe('scheduled')
    expect(exec.triggered_by).toBe('scheduler')

    // 反假跑 AC7: executor 真被调用，且拿到的是这条作业（DTO 由 schedules 行组装）
    expect(calls.length).toBe(1)
    expect(calls[0].job.id).toBe('t3-cron-1')
    expect(calls[0].job.config).toMatchObject({ type: 'workflow' })

    // 游标前移到未来（否则面板与 missed 检测都会说谎）
    const row = db.prepare('SELECT next_trigger_at FROM schedules WHERE id = ?').get('t3-cron-1') as
      { next_trigger_at: string | null }
    expect(row.next_trigger_at).not.toBeNull()
    expect(Date.parse(row.next_trigger_at!) > Date.now()).toBe(true)

    engine.stop()
    db.close()
  })

  it('AC7 负向: enabled=0 的作业到点不派发，也不留执行行', async () => {
    const db = newDb()
    insertJob(db, 't3-cron-off', { enabled: 0 })
    const { executor, calls } = makeMockExecutor()
    const executors = new Map<string, Executor>([['workflow', executor]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db), mockWorkspaceScheduleService, executors,
    )
    engine.start()

    await (engine as unknown as { triggerSchedule: (id: string) => void }).triggerSchedule('t3-cron-off')
    await new Promise((r) => setTimeout(r, 30))

    expect(calls.length).toBe(0)
    const cnt = db.prepare('SELECT COUNT(*) c FROM schedule_executions WHERE schedule_id = ?')
      .get('t3-cron-off') as { c: number }
    expect(cnt.c).toBe(0)

    engine.stop()
    db.close()
  })

  // ── AC3: 手动触发（enqueue 路由下线后唯一的手动入口）──────────────

  it('AC3: POST /jobs/:id/trigger 写 manual 执行行并经引擎派发', async () => {
    const db = newDb()
    const configDAO = new ScheduleConfigDAO(db)
    const runDAO = new ScheduleRunDAO(db)
    const service = new SchedulerService(configDAO, runDAO)
    const { executor, calls } = makeMockExecutor()
    const executors = new Map<string, Executor>([['workflow', executor]])
    const engine = new SchedulerEngine(configDAO, runDAO, mockWorkspaceScheduleService, executors)
    // 路由 → service.triggerJob → onTrigger 回调 → engine.triggerManual：这条线在 index.ts
    // 里接线，测试把它接一遍，证明「手动触发」和「到点触发」共用同一次派发。
    service.setCallbacks({ onTrigger: (id, schedExecId) => engine.triggerManual(id, schedExecId) })
    engine.start()

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

    await new Promise((r) => setTimeout(r, 50))

    // 反假跑: 执行行在 DB 里，且就是响应里那个 id
    const exec = db.prepare('SELECT status, trigger_type FROM schedule_executions WHERE id = ?')
      .get(body.execution_id) as { status: string; trigger_type: string }
    expect(exec.trigger_type).toBe('manual')
    expect(['triggered', 'running']).toContain(exec.status)
    expect(calls.map((c) => c.job.id)).toEqual([id])

    engine.stop()
    db.close()
  })
})
