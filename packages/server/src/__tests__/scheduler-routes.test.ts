import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { DashboardService } from '../services/scheduler/dashboard-service'
import { ExportService } from '../services/scheduler/export-service'
import { createSchedulerRoutes, resetSchedulerRateLimitersForTests } from '../routes/scheduler'
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
    // 票03 (ADR-0021): 这里原来还挂了一份 clone-session 路由 + AgentSessionDAO，为的是
    // G7「POST /jobs(requirement) 自动建 task-author 会话」。那条分支随 requirement 载荷
    // 一起从路由里删了（POST /api/scheduler/jobs 现在只做 createJob），夹具跟着撤。
    app = new Hono()
    app.route('/api/scheduler', createSchedulerRoutes(service, dashboard, exportService))
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

  it('POST /jobs rejects an absent cron_expression (jobs are cron-armed only since 票03)', async () => {
    // 票03 之后 POST /api/scheduler/jobs 是纯作业入口：不再接受 trigger_source /
    // task_spec / cron_expression=null 的「草稿信封」（那条 requirement 路径与
    // POST /jobs/:id/enqueue 一起下线，任务侧改走 /api/tasks 的 trigger）。
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'no-cron',
        job_type: 'workflow',
        cron_expression: null,
        timezone: 'Asia/Shanghai',
        org: 'test',
        trigger_source: 'requirement', // 旧载荷：必须被忽略，而不是被当成入队凭据
        config: { schema_version: '2.0', type: 'workflow', workspace_spec: { org: 'test', branch_prefix: 's', projects: [{ name: 'p', source_path: '/tmp' }] }, workflow_chain: [{ workflow_ref: 'x.yaml', input_values: {} }], max_retain: 10 },
      }),
    })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toMatch(/cron_expression/i)
    // 反假跑: 没有偷偷建出一行草稿
    const cnt = db.prepare("SELECT COUNT(*) as c FROM schedules WHERE name = 'no-cron'").get() as { c: number }
    expect(cnt.c).toBe(0)
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
  // ── 票03 (ADR-0021): 表里剩下的每一行都是作业 ────────────────────
  //
  // 本节原来有 6 条 requirement/enqueue 用例（AC21 toggle 拒绝、AC22-rev/AC22-compat、
  // ?origin=task、?origin=bogus→400、?trigger_source=requirement）与 3 条 G7（POST /jobs
  // 自动建 task-author clone 会话）：它们的主体是「一条 schedules 行可以是一个任务的信封」
  // 这件事 —— origin_* 列在 v42 删了，POST /jobs/:id/enqueue 与 ?trigger_source=&origin=
  // 两个查询参数一起下线，requirement 载荷在路由层就变成 400（上面那条用例钉住它）。
  // G7 的自动建会话分支也随 requirement 路径删除（routes/scheduler.ts 的 POST /jobs 现在
  // 只做 createJob）。保留的是仍然成立的那半句：列表与 DTO 里不该再有任何 origin 痕迹。

  const jobConfig = {
    schema_version: '2.0',
    type: 'workflow',
    workspace_spec: { org: 'test', branch_prefix: 'sched', projects: [{ name: 'p', source_path: '/tmp' }] },
    workflow_chain: [{ workflow_ref: 'g4.yaml', input_values: {} }],
    max_retain: 10,
  }

  async function createCronJob(prefix: string): Promise<string> {
    const res = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        job_type: 'workflow',
        cron_expression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        org: 'test',
        config: jobConfig,
      }),
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string }>(res)
    return body.id
  }

  it('DTO 不再携带 origin 字段，列表里每一行都是一个作业', async () => {
    const id = await createCronJob('t03-row')

    const res = await app.request('/api/scheduler/jobs')
    expect(res.status).toBe(200)
    const data = await json<{ items: Array<Record<string, unknown>> }>(res)
    const mine = data.items.find(j => j.id === id)
    expect(mine, '新建的作业出现在默认列表里（没有 origin 过滤可藏）').toBeDefined()
    // 反假跑: 字段是「不存在」，不是「为 null」—— SchedulerJob 上这几个键已删
    for (const gone of ['trigger_source', 'origin_type', 'origin_id', 'source_chat_session_id']) {
      expect(gone in mine!, `${gone} 不应再出现在作业 DTO 上`).toBe(false)
    }
    // 作业自己的 run-state 仍在（status/claimed_at 是泵的，不是任务的）
    expect(mine!.status).toBe('queued')
    expect('claimed_at' in mine!).toBe(true)
  })

  it('列表行的「上次触发」带耗时（票06 手测⑤：内置 job 那行要能看出跑了多久）', async () => {
    // 走真路由而不是单测 enrichJobRow：这一列的形状是「DAO 的相关子查询 → service 映射 →
    // wire」三段接起来的，之前正是因为本地又抄了一遍行类型，第四段子查询加了也没人发现。
    const id = await createCronJob('t05-dur')
    const insert = db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
         timezone_offset, timezone_iana, created_at, duration_ms)
       VALUES (?, ?, ?, 'scheduled', ?, '+00:00', 'UTC', ?, ?)`,
    )
    const older = new Date(Date.now() - 3600_000).toISOString()
    const newer = new Date().toISOString()
    insert.run(`${id}-e1`, id, 'failed', older, older, 9000)
    insert.run(`${id}-e2`, id, 'completed', newer, newer, 1234)

    const res = await app.request('/api/scheduler/jobs')
    const mine = (await json<{ items: Array<Record<string, unknown>> }>(res)).items.find(j => j.id === id)
    // 取最新那条（1234），不是任一行的最大值，也不是先插的那条。completed 在 DTO 上叫
    // success（mapExecutionStatus 的既有口径），断的是 wire，不是表里的词。
    expect(mine!.last_execution).toMatchObject({ status: 'success', duration_ms: 1234 })

    // skip 行没有引擎可计时 → 是 null，不是 0：0 会被 UI 念成「跑了 0ms」，那是假话
    insert.run(`${id}-e3`, id, 'skipped', new Date(Date.now() + 1000).toISOString(), newer, null)
    const after = (await json<{ items: Array<Record<string, unknown>> }>(
      await app.request('/api/scheduler/jobs'),
    )).items.find(j => j.id === id)
    expect(after!.last_execution).toMatchObject({ status: 'skipped', duration_ms: null })
  })

  // ── G4 (ticket 06): abort endpoint + workspace cleanup ──────────

  // Helper: create a cron job, then put it into the in-flight run-state a fire produces
  // (status claimed|running + claimed_at) with an ACTIVE schedule_execution and a
  // schedule_workspace row — i.e. exactly what triggerSchedule + WorkflowExecutor leave
  // behind, minus the envelope the ticket removed.
  async function createInFlightJob(
    status: 'claimed' | 'running' = 'claimed',
  ): Promise<{ id: string; execId: string; wsRowId: string }> {
    const id = await createCronJob('g4')
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
    const { id, execId, wsRowId } = await createInFlightJob('claimed')

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

    // audit log action='aborted' (filter by action — created_at ties with the prior
    // 'created' audit and makes ORDER BY created_at DESC nondeterministic)
    const audit = db.prepare(
      "SELECT action FROM scheduler_audit_logs WHERE schedule_id = ? AND action = 'aborted'",
    ).get(id) as { action: string } | undefined
    expect(audit, 'aborted audit log must exist').toBeDefined()
    expect(audit?.action).toBe('aborted')
  })

  it('G4: POST /jobs/:id/abort on running → aborted + executions failed', async () => {
    const { id, execId } = await createInFlightJob('running')

    const res = await app.request(`/api/scheduler/jobs/${id}/abort`, { method: 'POST' })
    expect(res.status).toBe(200)

    const sched = db.prepare('SELECT status FROM schedules WHERE id = ?').get(id) as { status: string }
    expect(sched.status).toBe('aborted')

    // markStaleExecutionsFailed covers status IN ('triggered','running') → 'running' too
    const exec = db.prepare('SELECT status FROM schedule_executions WHERE id = ?').get(execId) as { status: string }
    expect(exec.status).toBe('failed')
  })

  it('G4/AC: POST /jobs/:id/abort on a never-fired job → 400 (nothing in flight, status unchanged)', async () => {
    // 'draft' 这一档随信封消失：作业建出来就是 'queued'（= 已登记、无在飞），中止它对
    // 谁都不是一个转换。原来「draft → 400」与「queued → 400」两条用例现在同义，留一条。
    const id = await createCronJob('g4-idle')

    const res = await app.request(`/api/scheduler/jobs/${id}/abort`, { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toMatch(/status/i)

    // 反假跑: status unchanged (still queued, no partial mutation)
    const sched = db.prepare('SELECT status, claimed_at FROM schedules WHERE id = ?').get(id) as
      { status: string; claimed_at: string | null }
    expect(sched.status).toBe('queued')
    expect(sched.claimed_at).toBeNull()
  })

  it('G4/AC: POST /jobs/:id/abort on unknown → 404', async () => {
    const res = await app.request('/api/scheduler/jobs/nonexistent-job-id/abort', { method: 'POST' })
    expect(res.status).toBe(404)
  })
  // ── 票05: the built-in job is protected at the API, not just in the menu ──
  it('DELETE /jobs/builtin-* → 400,PUT 改 config → 400,但改 cron 仍可用', async () => {
    const { seedBuiltinCodeJobs } = await import('../services/scheduler/builtin-jobs')
    seedBuiltinCodeJobs(new ScheduleConfigDAO(db), 'test')
    const id = 'builtin-task-lifecycle'

    const del = await app.request(`/api/scheduler/jobs/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(400)
    expect((await json<{ error: string }>(del)).error).toContain('不可删除')
    // The row must still be there and still enabled — a refused delete changes nothing.
    expect((await json<{ items: Array<{ id: string }> }>(
      await app.request('/api/scheduler/jobs?job_type=job'),
    )).items.map((j) => j.id)).toContain(id)

    const ver = (await json<{ version: number }>(await app.request(`/api/scheduler/jobs/${id}`))).version
    const badCfg = await app.request(`/api/scheduler/jobs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': String(ver) },
      body: JSON.stringify({ config: { schema_version: '1.0', type: 'agent', prompt: 'clobber the handler' } }),
    })
    expect(badCfg.status).toBe(400)
    expect((await json<{ error: string }>(badCfg)).error).toContain('handler 指针')

    // What IS the user's to tune — the cadence — still goes through.
    const ver2 = (await json<{ version: number }>(await app.request(`/api/scheduler/jobs/${id}`))).version
    const okCron = await app.request(`/api/scheduler/jobs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': String(ver2) },
      body: JSON.stringify({ cron_expression: '*/5 * * * *' }),
    })
    expect(okCron.status).toBe(200)
  })

  // ── 票05: the list filter knows all three job types ────────────────
  it('GET /jobs?job_type=job 筛出 job 行，乱值等于不加过滤（cast 曾把 job 当不存在）', async () => {
    const created = await app.request('/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'e2e-job-row',
        job_type: 'job',
        cron_expression: '* * * * *',
        timezone: 'Asia/Shanghai',
        org: 'test',
        // 票02 的形状：库里只有 handler 名 + args，代码永不入库。
        config: { schema_version: '1.0', type: 'job', handler: 'task-lifecycle', args: {} },
      }),
    })
    expect(created.status).toBe(201)

    const onlyJobs = await json<{ items: Array<{ job_type: string }> }>(
      await app.request('/api/scheduler/jobs?job_type=job'),
    )
    expect(onlyJobs.items.length).toBeGreaterThan(0)
    expect(onlyJobs.items.every((j) => j.job_type === 'job')).toBe(true)

    // The route used to cast the query param to 'workflow' | 'agent'. A cast is not a
    // check: ?job_type=bogus reached the WHERE clause verbatim. Off-contract now reads
    // as "no filter", which is also what a typo means to a human.
    const unfiltered = await json<{ items: Array<{ job_type: string }>; total: number }>(
      await app.request('/api/scheduler/jobs?job_type=bogus'),
    )
    const all = await json<{ total: number }>(await app.request('/api/scheduler/jobs'))
    expect(unfiltered.total).toBe(all.total)
    expect(unfiltered.items.some((j) => j.job_type === 'job')).toBe(true)
  })

})
