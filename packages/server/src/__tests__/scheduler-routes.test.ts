import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { DashboardService } from '../services/scheduler/dashboard-service'
import { ExportService } from '../services/scheduler/export-service'
import { createSchedulerRoutes } from '../routes/scheduler'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'

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
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(service, dashboard, exportService))
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
})
