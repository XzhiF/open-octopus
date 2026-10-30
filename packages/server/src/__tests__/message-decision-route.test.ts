// 2026-10-30 决策卡写回：POST /messages/:id/decision
//
// 卡片消息是 append-only 的事件行；人的选择落在它的 metadata.activity 上
// （decision / decisions[entryId]），刷新后卡片仍是「所选高亮 + 只读」。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { AgentSessionDAO } from '../db/dao'
import { initSessionService } from '../services/agent/session-service'
import { createSessionRoutes } from '../routes/agent/sessions'

const ORG = 'e2e-decision'
const SESSION = 's-decision'
const MSG = 'm-decision-1'
let db: Database.Database
let sessionDAO: AgentSessionDAO
let app: Hono

function post(body: unknown, id = MSG) {
  return app.request(`/api/agent/messages/${id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Octopus-Org': ORG },
    body: JSON.stringify(body),
  })
}

function meta(): Record<string, unknown> {
  const row = sessionDAO.findMessageById(MSG)
  return JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>
}

beforeAll(() => {
  db = new Database(':memory:')
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  initSessionService(sessionDAO)
  app = new Hono()
  app.route('/api/agent', createSessionRoutes(sessionDAO))
})

afterAll(() => { db.close() })

beforeEach(() => {
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM sessions').run()
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION, repo_group: ORG, title: 'T', clone_name: null, session_type: 'main',
    created_at: now, updated_at: now,
  })
  sessionDAO.insertMessage({
    id: MSG,
    session_id: SESSION,
    role: 'user',
    content: '[任务工具 · task.launch_proposal] 启动方式待选择',
    metadata: JSON.stringify({
      displayType: 'event',
      activity: {
        kind: 'task.launch_proposal',
        title: '启动方式待选择',
        taskId: 't-1',
        actions: [{ id: 'launch_now', label: '立即执行' }],
      },
    }),
    created_at: now,
  })
})

describe('POST /messages/:id/decision', () => {
  it('卡片级选择写入 activity.decision', async () => {
    const res = await post({ actionId: 'launch_now', label: '立即执行' })
    expect(res.status).toBe(200)
    const m = meta()
    const activity = m.activity as Record<string, unknown>
    expect(activity.decision).toMatchObject({ id: 'launch_now', label: '立即执行' })
    expect(typeof (activity.decision as { at?: string }).at).toBe('string')
    // 原有卡片载荷不被抹掉
    expect(activity.title).toBe('启动方式待选择')
    expect(m.displayType).toBe('event')
  })

  it('反思条目按 entryId 写入 activity.decisions，互不覆盖', async () => {
    await post({ actionId: 'ingest', label: '落 wiki', entryId: 'refl-1' })
    await post({ actionId: 'skip', label: '跳过', entryId: 'refl-2' })
    const activity = meta().activity as Record<string, unknown>
    const decisions = activity.decisions as Record<string, { id: string }>
    expect(decisions['refl-1'].id).toBe('ingest')
    expect(decisions['refl-2'].id).toBe('skip')
    expect(activity.decision).toBeUndefined()
  })

  it('缺 actionId → 400；消息不存在 → 404', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ actionId: 'launch_now' }, 'm-missing')).status).toBe(404)
  })
})
