import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { DashboardService } from '../services/scheduler/dashboard-service'
import { ExportService } from '../services/scheduler/export-service'
import { createSchedulerRoutes } from '../routes/scheduler'
import { ScheduleConfigDAO, ScheduleRunDAO, ChatDAO } from '../db/dao'
import { ChatService } from '../services/chat'
import { SSEService } from '../services/sse'

describe('Scheduler Routes (integration)', () => {
  let db: Database.Database
  let app: Hono
  const wsId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, 'test-ws', 'test', '/tmp/test', datetime('now'), datetime('now'))
    `).run(wsId)

    const service = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
    const dashboard = new DashboardService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
    const exportService = new ExportService(new ScheduleConfigDAO(db))
    const chatService = new ChatService(new ChatDAO(db), new SSEService())
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(service, dashboard, exportService, chatService))
  })

  afterAll(() => {
    db.close()
  })

  // Helper: parse JSON body from Hono Response
  async function json<T>(res: Response): Promise<T> {
    return res.json() as Promise<T>
  }

  // ── Job CRUD ───────────────────────────────────────────────────

  it('GET /jobs returns empty list initially', async () => {
    const res = await app.request('/api/scheduler/jobs')
    expect(res.status).toBe(200)
    const data = await json<{ items: unknown[]; total: number }>(res)
    expect(data.items).toEqual([])
    expect(data.total).toBe(0)
  })

  it('POST /jobs creates a workflow job', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-wf',
        job_type: 'workflow',
        cron_expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        org: 'test',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: {
            org: 'test',
            branch_prefix: 'sched',
            projects: [{ name: 'proj', source_path: '/tmp/proj' }],
          },
          workflow_chain: [{ workflow_ref: 'test.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const job = await json<{ id: string; name: string; version: number }>(res)
    expect(job.name).toBe('test-wf')
    expect(job.version).toBe(1)
  })

  it('POST /jobs rejects duplicate name', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-wf',
        job_type: 'workflow',
        cron_expression: '0 10 * * *',
        timezone: 'UTC',
        org: 'test',
        config: { schema_version: '2.0', type: 'workflow', workspace_spec: { org: 'test', branch_prefix: 's', projects: [{ name: 'p', source_path: '/tmp' }] }, workflow_chain: [{ workflow_ref: 'other.yaml', input_values: {} }], max_retain: 10 },
      }),
    })
    expect(res.status).toBe(409)
  })

  it('POST /jobs rejects invalid cron', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-cron',
        job_type: 'workflow',
        cron_expression: 'invalid',
        timezone: 'UTC',
        org: 'test',
        config: { schema_version: '2.0', type: 'workflow', workspace_spec: { org: 'test', branch_prefix: 's', projects: [{ name: 'p', source_path: '/tmp' }] }, workflow_chain: [{ workflow_ref: 'x.yaml', input_values: {} }], max_retain: 10 },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('GET /jobs/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/scheduler/jobs/nonexistent')
    expect(res.status).toBe(404)
  })

  // ── PUT with If-Match ────────────────────────────────────────

  it('PUT /jobs/:id requires If-Match header', async () => {
    const listRes = await app.request('/api/scheduler/jobs')
    const { items } = await json<{ items: Array<{ id: string }> }>(listRes)
    const id = items[0].id

    const res = await app.request(`/api/scheduler/jobs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(res.status).toBe(428)
  })

  it('PUT /jobs/:id rejects stale version (409)', async () => {
    const listRes = await app.request('/api/scheduler/jobs')
    const { items } = await json<{ items: Array<{ id: string; version: number }> }>(listRes)
    const id = items[0].id

    const res = await app.request(`/api/scheduler/jobs/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '999',
      },
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(res.status).toBe(409)
  })

  it('PUT /jobs/:id with valid If-Match succeeds', async () => {
    const listRes = await app.request('/api/scheduler/jobs')
    const { items } = await json<{ items: Array<{ id: string; version: number }> }>(listRes)
    const { id, version } = items[0]

    const res = await app.request(`/api/scheduler/jobs/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': String(version),
      },
      body: JSON.stringify({ name: 'renamed-ok' }),
    })
    expect(res.status).toBe(200)
    const updated = await json<{ name: string; version: number }>(res)
    expect(updated.name).toBe('renamed-ok')
    expect(updated.version).toBe(version + 1)
  })

  // ── Actions ─────────────────────────────────────────────────

  it('POST /jobs/:id/toggle flips enabled', async () => {
    const listRes = await app.request('/api/scheduler/jobs')
    const { items } = await json<{ items: Array<{ id: string; enabled: boolean }> }>(listRes)
    const { id, enabled } = items[0]

    const res = await app.request(`/api/scheduler/jobs/${id}/toggle`, { method: 'POST' })
    expect(res.status).toBe(200)
    const toggled = await json<{ enabled: boolean }>(res)
    expect(toggled.enabled).toBe(!enabled)
  })

  it('POST /jobs/:id/trigger inserts execution record', async () => {
    const listRes = await app.request('/api/scheduler/jobs?status=enabled')
    const { items } = await json<{ items: Array<{ id: string }> }>(listRes)
    // Need an enabled job to trigger — toggle back on if needed
    const id = items[0]?.id
    if (!id) {
      // skip
      return
    }

    const res = await app.request(`/api/scheduler/jobs/${id}/trigger`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await json<{ execution_id: string; status: string }>(res)
    expect(data.status).toBe('triggered')
  })

  // ── Dashboard ──────────────────────────────────────────────

  it('GET /dashboard returns summary', async () => {
    const res = await app.request('/api/scheduler/dashboard')
    expect(res.status).toBe(200)
    const data = await json<{ total_active: number; range: string }>(res)
    expect(typeof data.total_active).toBe('number')
    expect(data.range).toBe('all')
  })

  it('D2: GET /dashboard with invalid range falls back to all', async () => {
    const res = await app.request('/api/scheduler/dashboard?range=invalid')
    expect(res.status).toBe(200)
    const data = await json<{ range: string }>(res)
    expect(data.range).toBe('all')
  })

  // ── Export ─────────────────────────────────────────────────

  it('D1: GET /dashboard/export?format=csv returns CSV', async () => {
    const res = await app.request('/api/scheduler/dashboard/export?format=csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const body = await res.text()
    expect(body).toContain('Name,Workspace')
  })

  it('GET /dashboard/export?format=pdf returns 501', async () => {
    const res = await app.request('/api/scheduler/dashboard/export?format=pdf')
    expect(res.status).toBe(501)
  })

  // ── Cron utilities ─────────────────────────────────────────

  it('POST /cron/parse parses valid cron', async () => {
    const res = await app.request('/api/scheduler/cron/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '0 9 * * *', timezone: 'UTC' }),
    })
    expect(res.status).toBe(200)
    const data = await json<{ valid: boolean; description: string }>(res)
    expect(data.valid).toBe(true)
    expect(data.description).toBeDefined()
  })

  // ── DELETE ────────────────────────────────────────────────

  it('DELETE /jobs/:id soft-deletes', async () => {
    const listRes = await app.request('/api/scheduler/jobs')
    const { items } = await json<{ items: Array<{ id: string }> }>(listRes)
    const id = items[0].id

    const res = await app.request(`/api/scheduler/jobs/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    // Verify gone from list
    const afterRes = await app.request('/api/scheduler/jobs')
    const after = await json<{ items: Array<{ id: string }> }>(afterRes)
    expect(after.items.find(j => j.id === id)).toBeUndefined()
  })

  // ── T-10: Scheduler Endpoint Isolation ────────────────────

  async function createRequirementJob(): Promise<string> {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `t10-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 't10.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string }>(res)
    return body.id
  }

  it('AC21: POST /jobs/:id/toggle on requirement-type returns 400', async () => {
    const id = await createRequirementJob()

    const res = await app.request(`/api/scheduler/jobs/${id}/toggle`, { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toMatch(/cron/i)

    // 反假跑 AC21: status 仍是 draft, 未变 enabled/disabled
    const detail = await app.request(`/api/scheduler/jobs/${id}`)
    const job = await json<{ status: string; enabled: boolean }>(detail)
    expect(['draft', 'queued', 'claimed']).toContain(job.status)
  })

  it('AC22: GET /jobs default excludes requirement-type records', async () => {
    await createRequirementJob()

    const res = await app.request('/api/scheduler/jobs')
    expect(res.status).toBe(200)
    const data = await json<{ items: Array<{ trigger_source?: string | null }> }>(res)
    // 反假跑 AC22: 默认响应不含 trigger_source='requirement' 记录
    expect(data.items.every(j => (j.trigger_source ?? 'cron') !== 'requirement')).toBe(true)
  })

  it('AC22: GET /jobs?trigger_source=requirement returns only requirement-type records', async () => {
    await createRequirementJob()

    const res = await app.request('/api/scheduler/jobs?trigger_source=requirement')
    expect(res.status).toBe(200)
    const data = await json<{ items: Array<{ trigger_source?: string | null }> }>(res)
    expect(data.items.length).toBeGreaterThan(0)
    // 反假跑: 所有记录都是 requirement
    expect(data.items.every(j => j.trigger_source === 'requirement')).toBe(true)
  })

  // ── T-9: Chat Session Binding ─────────────────────────────────

  it('AC18: POST /jobs with trigger_source=requirement auto-creates chat session + returns source_chat_session_id', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `t9-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 't9.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string; source_chat_session_id: string | null }>(res)
    // 反假跑 AC18: source_chat_session_id 非空 (auto-created by route)
    expect(body.source_chat_session_id).toBeTruthy()
    expect(typeof body.source_chat_session_id).toBe('string')

    // 反假跑: chat_sessions 表真有这条记录, 不只是 API 返回对了
    const chatRow = db.prepare(
      'SELECT id, workspace_id FROM chat_sessions WHERE id = ?'
    ).get(body.source_chat_session_id) as { id: string; workspace_id: string } | undefined
    expect(chatRow).toBeDefined()
    expect(chatRow!.workspace_id).toBe('taskpool-draft')
  })

  it('AC18 反假跑: caller-provided source_chat_session_id is preserved (no auto-create override)', async () => {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `t9-explicit-${Date.now()}`,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        source_chat_session_id: 'caller-provided-session-id',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 't9.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ source_chat_session_id: string | null }>(res)
    // Caller's session id preserved, not overridden
    expect(body.source_chat_session_id).toBe('caller-provided-session-id')
  })

  it('AC19: GET /jobs/:id returns source_chat_session_id for requirement-type draft', async () => {
    // Create a draft (auto-creates chat session)
    const createRes = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `t9-get-${Date.now()}`,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 't9.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    const created = await json<{ id: string; source_chat_session_id: string | null }>(createRes)
    expect(created.source_chat_session_id).toBeTruthy()

    // 反假跑 AC19: GET 接口返回 source_chat_session_id 字段
    const getRes = await app.request(`/api/scheduler/jobs/${created.id}`)
    expect(getRes.status).toBe(200)
    const body = await json<{ id: string; source_chat_session_id: string | null }>(getRes)
    expect(body.id).toBe(created.id)
    expect(body.source_chat_session_id).toBe(created.source_chat_session_id)
    expect(body.source_chat_session_id).toBeTruthy()
  })
})
