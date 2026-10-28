// Regression: GET /sessions/:id hands the transcript a `tool_calls` field the
// UI iterates. The messages column historically held three shapes — the
// { thinking?, tool_calls? } wrapper, a legacy plain array, and junk "{}" rows
// (an all-empty wrapper some writers used to serialize). Leaking a non-array
// through blanked the whole app on mount (TuiTranscript: "not iterable"), so
// the route must hand out null for anything that is not an array.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { AgentSessionDAO } from '../db/dao'
import { initSessionService } from '../services/agent/session-service'
import { createSessionRoutes } from '../routes/agent/sessions'

const ORG = 'e2e-msg-shape'
const SESSION = 's-msg-shape'
let db: Database.Database
let sessionDAO: AgentSessionDAO
let app: Hono

function get() {
  return app.request(`/api/agent/sessions/${SESSION}?limit=50`, {
    headers: { 'Content-Type': 'application/json', 'X-Octopus-Org': ORG },
  })
}

beforeAll(() => {
  db = new Database(':memory:')
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  initSessionService(sessionDAO)
  app = new Hono()
  app.route('/api/agent', createSessionRoutes(sessionDAO))
})

afterAll(() => {
  db.close()
})

beforeEach(() => {
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM sessions').run()
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION, repo_group: ORG, title: 'T', clone_name: null, session_type: 'main',
    created_at: now, updated_at: now,
  })
})

function seed(content: string, toolCalls: string | null, createdAt: string) {
  sessionDAO.insertMessage({
    id: `m-${content}`, session_id: SESSION, role: 'assistant',
    content, tool_calls: toolCalls, created_at: createdAt,
  })
}

describe('GET /sessions/:id — tool_calls column shapes', () => {
  it('junk "{}" rows come out as tool_calls null (never a non-array)', async () => {
    seed('junk', '{}', '2026-01-01T00:00:01.000Z')
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: { items: Array<Record<string, unknown>> } }
    const msg = body.messages.items.find((m) => m.content === 'junk')!
    expect(msg.tool_calls).toBeNull()
    expect(msg.thinking).toBeUndefined()
  })

  it('wrapper with thinking keeps thinking and nulls tool_calls', async () => {
    seed('thinking-only', JSON.stringify({ thinking: 'think-a' }), '2026-01-01T00:00:02.000Z')
    const res = await get()
    const body = await res.json() as { messages: { items: Array<Record<string, unknown>> } }
    const msg = body.messages.items.find((m) => m.content === 'thinking-only')!
    expect(msg.thinking).toBe('think-a')
    expect(msg.tool_calls).toBeNull()
  })

  it('wrapper with a tool list passes the array through', async () => {
    const tools = [{ id: 'tc-1', name: 'Bash', status: 'success' }]
    seed('tools', JSON.stringify({ thinking: 't', tool_calls: tools }), '2026-01-01T00:00:03.000Z')
    const res = await get()
    const body = await res.json() as { messages: { items: Array<Record<string, unknown>> } }
    const msg = body.messages.items.find((m) => m.content === 'tools')!
    expect(msg.tool_calls).toEqual(tools)
  })

  it('legacy plain-array rows pass through, junk-wrapped arrays do not leak objects', async () => {
    seed('legacy', JSON.stringify([{ id: 'tc-legacy', name: 'Read' }]), '2026-01-01T00:00:04.000Z')
    seed('broken', '{not json', '2026-01-01T00:00:05.000Z')
    const res = await get()
    const body = await res.json() as { messages: { items: Array<Record<string, unknown>> } }
    const legacy = body.messages.items.find((m) => m.content === 'legacy')!
    const broken = body.messages.items.find((m) => m.content === 'broken')!
    expect(legacy.tool_calls).toEqual([{ id: 'tc-legacy', name: 'Read' }])
    expect(broken.tool_calls).toBeNull()
  })
})