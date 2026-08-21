import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { DashboardService } from '../services/scheduler/dashboard-service'
import { ExportService } from '../services/scheduler/export-service'
import { createSchedulerRoutes } from '../routes/scheduler'

// T-1: Schema 扩展 + 草稿创建
// 验收标准：
//   AC1  - SELECT origin_type FROM schedules WHERE id=? 返回 'task' (v1 'requirement' equivalent)
//   AC10 - PRAGMA table_info(schedules) 含新列 (origin_type, origin_id, origin_role, claimed_at) + 类型正确
//   AC12 - POST body 含 trigger_source='requirement' + cron_expression=null 不报错，返回 schedule.id
//
// 反假跑：
//   AC1  - 显式查 origin_type 字段值，不只查 status='queued'
//   AC10 - PRAGMA 查列存在 + 类型正确，不只 INSERT 不报错
//   AC12 - Zod 校验真通过 + 返回的 body 含 id，不只 POST 200
//
// SG1b (ticket 06): trigger_source + source_chat_session_id were DROPPED from schedules.
// The承重 sites below use origin_type (S2 polymorphic origin). The route still accepts
// trigger_source='requirement' in the POST body (backward-compat) — createJob maps it to
// origin_type='task'. source_chat_session_id is no longer persisted (tasks table owns the
// chat-session back-ref now).

const ORG = 'task-pool-test'

describe('T-1: Schema 扩展 + 草稿创建', () => {
  let db: Database.Database
  let app: Hono
  let service: SchedulerService

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)

    service = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
    const dashboard = new DashboardService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
    const exportService = new ExportService(new ScheduleConfigDAO(db))
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(service, dashboard, exportService))
  })

  afterAll(() => {
    db.close()
  })

  async function json<T>(res: Response): Promise<T> {
    return res.json() as Promise<T>
  }

  // ── AC10: PRAGMA 反假跑 — 列存在 + 类型正确 ────────────────────

  it('AC10: schedules 表含 origin_type/origin_id/origin_role/claimed_at 列 + 类型正确', () => {
    const cols = db.prepare('PRAGMA table_info(schedules)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>

    // SG1b (ticket 06): trigger_source + source_chat_session_id DROPPED → S2 polymorphic
    // origin cols (origin_type/origin_id/origin_role). claimed_at kept (task lifecycle).
    const originType = cols.find(c => c.name === 'origin_type')
    expect(originType, 'origin_type 列必须存在').toBeDefined()
    expect(originType!.type).toBe('TEXT')
    expect(originType!.notnull).toBe(1) // NOT NULL DEFAULT 'cron'
    expect(originType!.dflt_value).toBe("'cron'")

    const originId = cols.find(c => c.name === 'origin_id')
    expect(originId, 'origin_id 列必须存在').toBeDefined()
    expect(originId!.type).toBe('TEXT')
    expect(originId!.notnull).toBe(0) // nullable

    const originRole = cols.find(c => c.name === 'origin_role')
    expect(originRole, 'origin_role 列必须存在').toBeDefined()
    expect(originRole!.type).toBe('TEXT')
    expect(originRole!.notnull).toBe(0) // nullable

    const claimedAt = cols.find(c => c.name === 'claimed_at')
    expect(claimedAt, 'claimed_at 列必须存在').toBeDefined()
    expect(claimedAt!.type).toBe('TEXT')
    expect(claimedAt!.notnull).toBe(0)

    // cron_expression 应当 nullable (schema v37)
    const cron = cols.find(c => c.name === 'cron_expression')
    expect(cron, 'cron_expression 列必须存在').toBeDefined()
    expect(cron!.notnull).toBe(0)

    // status 是新加的状态列
    const status = cols.find(c => c.name === 'status')
    expect(status, 'status 列必须存在').toBeDefined()
    expect(status!.type).toBe('TEXT')
    expect(status!.notnull).toBe(1) // NOT NULL DEFAULT 'queued'
  })

  // ── AC1 + AC12: DAO 直接创建 + 显式查 trigger_source ───────────

  it('AC1/AC12 (DAO 路径): 直接 INSERT origin_type=task 后显式查字段值', () => {
    const id = 't1-dao-direct'
    const now = new Date().toISOString()

    // SG1b (ticket 06): trigger_source + source_chat_session_id DROPPED → origin_type='task'
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy,
        version, consecutive_failures, max_retain,
        status, origin_type, claimed_at
      ) VALUES (?, ?, ?, NULL, 'Asia/Shanghai', 0, 3600, 0, ?, ?, 'workflow', '{}', 'skip', 1, 0, 10, 'draft', 'task', NULL)
    `).run(id, ORG, 'dao-direct', now, now)

    // 反假跑 AC1: 显式 SELECT origin_type 字段值，不只查 status
    const row = db.prepare(
      'SELECT origin_type, status, claimed_at, cron_expression FROM schedules WHERE id = ?'
    ).get(id) as {
      origin_type: string
      status: string
      claimed_at: string | null
      cron_expression: string | null
    }

    expect(row.origin_type).toBe('task') // 反假跑: 显式查 origin_type (v1 'requirement')
    expect(row.status).toBe('draft')
    expect(row.claimed_at).toBeNull()
    expect(row.cron_expression).toBeNull() // 反假跑: cron_expression 真的 NULL, 不是空串
  })

  // ── AC12: POST /jobs with trigger_source='requirement' + cron_expression=null ──

  it('AC12: POST /jobs with trigger_source=requirement + cron_expression=null 返回 id (Zod 真通过)', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 't1-post-draft',
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: ORG,
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: {
            org: ORG,
            branch_prefix: 'draft',
            projects: [{ name: 'p', source_path: '/tmp' }],
          },
          workflow_chain: [{ workflow_ref: 'test.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })

    // 反假跑 AC12: 不只看 status=201，必须验证 Zod 真通过 (无 400) + body 含 id
    expect(res.status).toBe(201)
    const body = await json<{
      id: string
      name: string
      trigger_source: string
      status: string
      cron_expression: string | null
    }>(res)
    expect(body.id).toBeTruthy() // 反假跑: body 真有 id
    expect(body.name).toBe('t1-post-draft')
    expect(body.trigger_source).toBe('requirement')
    expect(body.status).toBe('draft')
    expect(body.cron_expression).toBeNull()

    // 反假跑: DB 中确实存了 origin_type='task' (v1 'requirement' equivalent)，不只 API 返回对了
    const dbRow = db.prepare(
      'SELECT origin_type, status, cron_expression FROM schedules WHERE id = ?'
    ).get(body.id) as {
      origin_type: string
      status: string
      cron_expression: string | null
    }
    expect(dbRow.origin_type).toBe('task')
    expect(dbRow.status).toBe('draft')
    expect(dbRow.cron_expression).toBeNull()
  })

  // ── AC12 反假跑: Zod 必须拒绝 trigger_source='cron' 但缺 cron_expression ──

  it('AC12 反假跑: POST /jobs with trigger_source=cron 但 cron_expression=null 返回 400', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 't1-zod-reject',
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: ORG,
        trigger_source: 'cron', // cron 触发源必须有 cron_expression
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: ORG, branch_prefix: 'x', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 'x.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    // 反假跑: Zod 真做了 superRefine 校验, 不只是表面接收
    expect(res.status).toBe(400)
  })

  // ── source_chat_session_id persistence (REMOVED in SG1b) ──────────────
  // SKIPPED (ticket 06 SG1b): source_chat_session_id is no longer persisted on
  // schedules (column DROPPED). The tasks table owns the chat-session back-ref now.
  // The route still ACCEPTS source_chat_session_id in the POST body (backward-compat),
  // but enrichJobRow returns null always and the DB column is gone, so persistence
  // cannot be asserted here. The auto-created task-author clone session is verified
  // in scheduler-routes.test.ts (G7) via the `sessions` table (scope_id = task id).
  it.skip('POST /jobs 把 source_chat_session_id 持久化到 schedules 表 (REMOVED in SG1b)', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 't1-session-id-persistence',
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: ORG,
        trigger_source: 'requirement',
        source_chat_session_id: 'chat-abc-123',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: ORG, branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 'test.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string; source_chat_session_id: string | null }>(res)
    expect(body.source_chat_session_id).toBe('chat-abc-123')

    const row = db.prepare(
      'SELECT source_chat_session_id FROM schedules WHERE id = ?'
    ).get(body.id) as { source_chat_session_id: string | null }
    expect(row.source_chat_session_id).toBe('chat-abc-123')
  })
})
