import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { DashboardService } from '../services/scheduler/dashboard-service'
import { ExportService } from '../services/scheduler/export-service'
import { createSchedulerRoutes, resetSchedulerRateLimitersForTests } from '../routes/scheduler'
import { createCloneSessionRoutes } from '../routes/clone'
import { ScheduleConfigDAO, ScheduleRunDAO, AgentSessionDAO } from '../db/dao'

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
    // G7: scheduler route now binds a REAL task-author clone session (sessions table)
    // via AgentSessionDAO, replacing the retired 'taskpool-draft' chat_sessions sentinel.
    const agentSessionDAO = new AgentSessionDAO(db)
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(service, dashboard, exportService, agentSessionDAO))
    // Mount clone routes so task-author chat session resolves via the clone-session mechanism.
    app.route('/api/clones', createCloneSessionRoutes({ sessionDAO: agentSessionDAO }))
  })

  afterAll(() => {
    db.close()
  })

  // Reset rate-limiter buckets before each test. The suite shares one app, so
  // the module-level limiters would otherwise accumulate >maxTokens writes
  // across tests and falsely 429 later assertions (test-isolation, not real
  // rate limiting).
  beforeEach(() => {
    resetSchedulerRateLimitersForTests()
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

  // ── G7: task-author clone session binding (retires 'taskpool-draft' sentinel) ──

  it('G7/AC18: POST /jobs with trigger_source=requirement auto-creates a REAL task-author clone session + scope_id=job.id', async () => {
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
    // SG1b (ticket 06): source_chat_session_id is no longer persisted on schedules
    // (column DROPPED). enrichJobRow returns null always. The auto-created task-author
    // clone session is still created (G7 preserved) — find it via scope_id = task id below.
    expect(body.source_chat_session_id).toBeNull()

    // G7: session is a REAL clone session in the `sessions` table (clone-session mechanism),
    // NOT a chat_sessions row with the retired 'taskpool-draft' fake workspace_id.
    // SG1b: look up by scope_id = body.id (the route links scope_id to the task id).
    const sessionRow = db.prepare(
      'SELECT id, clone_name, session_type, scope_id, is_deleted FROM sessions WHERE scope_id = ? AND clone_name = ?'
    ).get(body.id, 'task-author') as
      | { id: string; clone_name: string; session_type: string; scope_id: string | null; is_deleted: number }
      | undefined
    expect(sessionRow, 'task-author clone session must exist in sessions table (scope_id=task_id)').toBeDefined()
    expect(sessionRow!.clone_name).toBe('task-author')
    expect(sessionRow!.session_type).toBe('clone_direct')
    expect(sessionRow!.scope_id).toBe(body.id) // linked to the task id (G7: scope_id=task_id)
    expect(sessionRow!.is_deleted).toBe(0)

    // G7 反假跑: NO 'taskpool-draft' fake workspace_id row in chat_sessions (sentinel retired)
    const chatRow = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(sessionRow!.id)
    expect(chatRow, 'chat_sessions must NOT carry the retired taskpool-draft sentinel').toBeUndefined()
  })

  it('G7: POST /api/clones/task-author/sessions/:id/chat resolves the real clone session (not 404)', async () => {
    // Create a requirement draft → auto-creates a task-author clone session with scope_id=job.id
    const createRes = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `g7-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 'g7.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(createRes.status).toBe(201)
    const created = await json<{ id: string; source_chat_session_id: string | null }>(createRes)
    // SG1b: source_chat_session_id no longer in response (null). The auto-created
    // task-author clone session still exists — find it via scope_id = task id.
    expect(created.source_chat_session_id).toBeNull()
    const session = db.prepare(
      'SELECT id FROM sessions WHERE scope_id = ? AND clone_name = ?'
    ).get(created.id, 'task-author') as { id: string } | undefined
    expect(session, 'task-author clone session must exist (scope_id=task_id)').toBeDefined()
    const sessionId = session!.id

    // The auto-created session is a real task-author clone session, so the generic
    // clone chat route must resolve it (200 SSE stream). The provider may error
    // inside the stream, but the session+clone must NOT 404.
    const chatRes = await app.request(`/api/clones/task-author/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'draft a simple task spec' }),
    })
    expect(chatRes.status).toBe(200)
    // Drain the SSE body so the stream completes cleanly
    await chatRes.text()
  })

  it('G7: createJob failure rolls back the auto-created task-author session (no orphan)', async () => {
    // Baseline: create a requirement draft whose name we will duplicate
    const dupName = `E2E_TP_rollback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const first = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: dupName,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 'r.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(first.status).toBe(201)

    // Count ACTIVE task-author clone sessions right before the failing create
    const activeBefore = (db.prepare(
      "SELECT COUNT(*) as c FROM sessions WHERE clone_name = 'task-author' AND is_deleted = 0"
    ).get() as { c: number }).c

    // Duplicate name → 409. The route auto-creates a session BEFORE calling createJob,
    // then createJob throws → the catch block must roll the orphan session back.
    const dup = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: dupName,
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: { org: 'test', branch_prefix: 'draft', projects: [{ name: 'p', source_path: '/tmp' }] },
          workflow_chain: [{ workflow_ref: 'r.yaml', input_values: {} }],
          max_retain: 10,
        },
      }),
    })
    expect(dup.status).toBe(409)

    // 反假跑: NO active orphan session left (the rolled-back one is is_deleted=1, not chattable)
    const activeAfter = (db.prepare(
      "SELECT COUNT(*) as c FROM sessions WHERE clone_name = 'task-author' AND is_deleted = 0"
    ).get() as { c: number }).c
    expect(activeAfter).toBe(activeBefore)
  })

  // SKIPPED (ticket 06 SG1b): source_chat_session_id is no longer persisted on schedules
  // (column DROPPED) — enrichJobRow returns null always, so a caller-provided id cannot
  // be round-tripped via the response. The tasks table owns the chat-session back-ref now.
  it.skip('AC18 反假跑: caller-provided source_chat_session_id is preserved (no auto-create override)', async () => {
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

  // SKIPPED (ticket 06 SG1b): source_chat_session_id is no longer persisted on schedules
  // (column DROPPED) — GET /jobs/:id returns null always. The tasks table owns the
  // chat-session back-ref now; the auto-created task-author clone session is verified in
  // G7/AC18 above (via sessions.scope_id = task id).
  it.skip('AC19: GET /jobs/:id returns source_chat_session_id for requirement-type draft', async () => {
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
    expect(createRes.status).toBe(201)
    expect(created.source_chat_session_id).toBeTruthy()

    // 反假跑 AC19: GET 接口返回 source_chat_session_id 字段
    const getRes = await app.request(`/api/scheduler/jobs/${created.id}`)
    expect(getRes.status).toBe(200)
    const body = await json<{ id: string; source_chat_session_id: string | null }>(getRes)
    expect(body.id).toBe(created.id)
    expect(body.source_chat_session_id).toBe(created.source_chat_session_id)
    expect(body.source_chat_session_id).toBeTruthy()
  })

  // ── G4 (ticket 06): abort endpoint + workspace cleanup ──────────

  // Helper: create a requirement draft, enqueue → queued, then simulate the
  // engine claim (status='claimed', claimed_at set) + insert an ACTIVE
  // schedule_execution (status='triggered') and a schedule_workspace row
  // (status='running') so the abort path has the full in-flight state to tear
  // down. Mirrors what checkQueuedTasks + dispatchExecution produce at runtime.
  async function createClaimedScheduleWithActiveExecution(
    status: 'claimed' | 'running' = 'claimed',
  ): Promise<{ id: string; execId: string; wsRowId: string }> {
    const id = await createRequirementJob() // status='draft'
    // draft → queued (confirm gate)
    const enq = await app.request(`/api/scheduler/jobs/${id}/enqueue`, { method: 'POST' })
    expect(enq.status).toBe(200)

    const now = new Date().toISOString()
    db.prepare('UPDATE schedules SET status = ?, claimed_at = ? WHERE id = ?').run(status, now, id)

    const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, execution_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, NULL, ?, 'scheduled', ?, '+00:00', 'UTC', ?, 'scheduler')`,
    ).run(execId, id, status === 'running' ? 'running' : 'triggered', now, now)

    const wsRowId = `sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    db.prepare(
      `INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at)
       VALUES (?, ?, ?, 'running', 'abort-test', ?)`,
    ).run(wsRowId, id, wsId, now)

    return { id, execId, wsRowId }
  }

  it('G4/AC15: POST /jobs/:id/abort on claimed → aborted + executions failed + ws cleaned + audit', async () => {
    const { id, execId, wsRowId } = await createClaimedScheduleWithActiveExecution('claimed')

    const res = await app.request(`/api/scheduler/jobs/${id}/abort`, { method: 'POST' })
    expect(res.status).toBe(200)

    // schedules.status = 'aborted', claimed_at cleared (terminal)
    const sched = db.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get(id) as
      { status: string; claimed_at: string | null }
    expect(sched.status).toBe('aborted')
    expect(sched.claimed_at).toBeNull()

    // unique_active released: the active schedule_execution is now 'failed'
    const exec = db.prepare('SELECT status, error_summary FROM schedule_executions WHERE id = ?').get(execId) as
      { status: string; error_summary: string | null }
    expect(exec.status).toBe('failed')
    expect(exec.error_summary).toMatch(/abort/i)

    // unique_active truly released: a NEW triggered execution inserts without conflict
    // (idx_sched_execs_unique_active is a partial index on status IN triggered/running)
    const newExecId = `exec2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const insertNew = db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'triggered', 'scheduled', ?, '+00:00', 'UTC', ?, 'scheduler')`,
    )
    expect(() => insertNew.run(newExecId, id, new Date().toISOString(), new Date().toISOString())).not.toThrow()
    db.prepare('DELETE FROM schedule_executions WHERE id = ?').run(newExecId)

    // ws marked cleaned
    const sw = db.prepare('SELECT status FROM schedule_workspaces WHERE id = ?').get(wsRowId) as { status: string }
    expect(sw.status).toBe('cleaned')

    // audit log action='aborted' (filter by action — created_at ties with the
    // prior 'enqueued' audit make ORDER BY created_at DESC nondeterministic)
    const audit = db.prepare(
      "SELECT action FROM scheduler_audit_logs WHERE schedule_id = ? AND action = 'aborted'",
    ).get(id) as { action: string } | undefined
    expect(audit, 'aborted audit log must exist').toBeDefined()
    expect(audit?.action).toBe('aborted')
  })

  it('G4: POST /jobs/:id/abort on running → aborted + executions failed', async () => {
    const { id, execId } = await createClaimedScheduleWithActiveExecution('running')

    const res = await app.request(`/api/scheduler/jobs/${id}/abort`, { method: 'POST' })
    expect(res.status).toBe(200)

    const sched = db.prepare('SELECT status FROM schedules WHERE id = ?').get(id) as { status: string }
    expect(sched.status).toBe('aborted')

    // markStaleExecutionsFailed covers status IN ('triggered','running') → 'running' too
    const exec = db.prepare('SELECT status FROM schedule_executions WHERE id = ?').get(execId) as { status: string }
    expect(exec.status).toBe('failed')
  })

  it('G4/AC: POST /jobs/:id/abort on a draft → 400 (not abortable, status unchanged)', async () => {
    const id = await createRequirementJob() // status='draft'

    const res = await app.request(`/api/scheduler/jobs/${id}/abort`, { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toMatch(/status/i)

    // 反假跑: status unchanged (still draft, no partial mutation)
    const sched = db.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get(id) as
      { status: string; claimed_at: string | null }
    expect(sched.status).toBe('draft')
  })

  it('G4/AC: POST /jobs/:id/abort on queued → 400 (not yet claimed)', async () => {
    const id = await createRequirementJob()
    const enq = await app.request(`/api/scheduler/jobs/${id}/enqueue`, { method: 'POST' })
    expect(enq.status).toBe(200)

    const res = await app.request(`/api/scheduler/jobs/${id}/abort`, { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('G4/AC: POST /jobs/:id/abort on unknown → 404', async () => {
    const res = await app.request('/api/scheduler/jobs/nonexistent-job-id/abort', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
