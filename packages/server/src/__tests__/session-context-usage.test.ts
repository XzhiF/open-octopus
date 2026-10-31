// 冷启动 ctx 契约（任意浏览器 / 无痕都该有数）：
//   ① 有 provider 上报值（sessions.context_usage）→ 原样返回，无 estimated 标记；
//   ② 只有 token 账本（修复上线前的轮次）→ 返回 estimated 估算；
//   ③ 什么都没有 → null（前端才显示 ctx --%）；
//   ④ 估算只读：接口返回后不得回写 sessions.context_usage。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { AgentSessionDAO } from '../db/dao'
import { TokenUsageDAO } from '../db/dao/token-usage-dao'
import { initSessionService } from '../services/agent/session-service'
import { createSessionRoutes } from '../routes/agent/sessions'

const ORG = 'e2e-session-ctx'
const SESSION = 's-ctx'

let db: Database.Database
let sessionDAO: AgentSessionDAO
let tokenDao: TokenUsageDAO
let app: Hono

function get() {
  return app.request(`/api/agent/sessions/${SESSION}?limit=50`, {
    headers: { 'Content-Type': 'application/json', 'X-Octopus-Org': ORG },
  })
}

function insertLedger(): void {
  tokenDao.insertLlmCall({
    id: 'llm-ctx-1',
    node_execution_id: null,
    execution_id: null,
    turn_index: 1,
    call_index: 0,
    message_id: null,
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    timestamp: Date.now(),
    duration_ms: 1000,
    ttft_ms: null,
    input_tokens: 46964,
    output_tokens: 1004,
    cache_read_tokens: 50944,
    cache_creation_tokens: 0,
    workspace_id: null,
    workflow_ref: null,
    node_id: null,
    session_id: SESSION,
    instance_id: null,
    source_path: 'global_chat',
  })
}

beforeAll(() => {
  db = new Database(':memory:')
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  tokenDao = new TokenUsageDAO(db)
  initSessionService(sessionDAO)
  app = new Hono()
  app.route('/api/agent', createSessionRoutes(sessionDAO))
})

afterAll(() => {
  db.close()
})

beforeEach(() => {
  db.prepare('DELETE FROM llm_calls').run()
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM sessions').run()
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION, repo_group: ORG, title: 'T', clone_name: null, session_type: 'main',
    created_at: now, updated_at: now,
  })
})

describe('GET /sessions/:id — context_usage cold load', () => {
  it('nothing recorded → context_usage null (ctx --%)', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as { context_usage: unknown }
    expect(body.context_usage).toBeNull()
  })

  it('ledger only → estimated payload from the last turn tokens', async () => {
    insertLedger()
    const res = await get()
    const body = await res.json() as {
      context_usage: { totalTokens: number; maxTokens: number; percentage: number; model: string; estimated?: boolean }
    }
    // 46964 + 1004 + 50944 = 98912 tokens, 默认窗口 200k → 49.5%
    expect(body.context_usage).toMatchObject({
      totalTokens: 98912,
      maxTokens: 200000,
      percentage: 49.5,
      model: 'claude-opus-5',
      estimated: true,
    })
  })

  it('provider report wins over the ledger and carries no estimated flag', async () => {
    insertLedger()
    sessionDAO.updateContextUsage(SESSION, JSON.stringify({
      categories: [{ name: 'System prompt', tokens: 7993, color: 'promptBorder' }],
      totalTokens: 43960,
      maxTokens: 967000,
      rawMaxTokens: 967000,
      percentage: 5,
      model: 'claude-sonnet-5[1M]',
    }))

    const body = await (await get()).json() as { context_usage: { percentage: number; estimated?: boolean } }
    expect(body.context_usage.percentage).toBe(5)
    expect(body.context_usage.estimated).toBeUndefined()
  })

  it('the estimate is read-only — never written back to the sessions column', async () => {
    insertLedger()
    await get()
    const row = db.prepare('SELECT context_usage FROM sessions WHERE id = ?').get(SESSION) as { context_usage: string | null }
    expect(row.context_usage).toBeNull()
  })
})
