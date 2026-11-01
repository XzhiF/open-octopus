// packages/server/src/__tests__/slash-command-chat.test.ts
//
// 斜杠命令路由契约（2026-10-31）：
//   CLI 本地命令只通过 result.content 回话（没有 stream_event 增量），
//   旧路由把它丢掉 → 界面既无输出也不收尾（永转圈）。这里钉住：
//   ① /context 这类 result-only 正文必须下发并落库；
//   ② /compact 这类空正文轮仍必须发 done（前端靠它复位）；
//   ③ /clear 的 conversation_reset 只清 provider 会话指针，聊天记录不动；
//   ④ system:init 的 slash_commands 要透传给前端并可从接口回读。
//
// Anti-fake-run: 真 better-sqlite3 + applySchema + Hono app.request，
// fake provider 按真机 SDK 的事件形状吐 chunk。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { applySchema } from '../db/schema'
import { AgentSessionDAO } from '../db/dao'
import { TokenUsageDAO } from '../db/dao/token-usage-dao'
import { createChatRoutes } from '../routes/agent/chat-routes'
import { initAgentService } from '../services/agent/agent-service'
import { projectDirKey } from '../services/agent/resume'
import type { MessageChunk } from '@octopus/providers'
import * as providers from '@octopus/providers'

const ORG = 'E2E_TEST_slash_command_chat'
const SESSION = 's-slash-chat'
const ROOT = path.join(os.tmpdir(), `slash-command-chat-${Date.now()}`)
const HOME = path.join(ROOT, 'octopus')
const CLAUDE_DIR = path.join(ROOT, 'claude')
const AGENT_DIR = path.join(HOME, 'agent')

let db: Database.Database
let sessionDAO: AgentSessionDAO
let tokenUsageDao: TokenUsageDAO
let script: MessageChunk[][]

function installProvider() {
  vi.spyOn(providers, 'getProvider').mockImplementation((() => ({
    sendQuery: async function* () {
      const chunks = script.shift() ?? []
      for (const chunk of chunks) yield chunk
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route('/api/agent', createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao,
  }))
  return a
}

const HEADERS = { 'Content-Type': 'application/json', 'X-Octopus-Org': ORG }

function chat(message: string) {
  return app().request(`/api/agent/sessions/${SESSION}/chat`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ message }),
  })
}

function assistantRows() {
  return db.prepare(
    "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC",
  ).all(SESSION) as Array<{ id: string; content: string; metadata: string | null }>
}

const USAGE = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 }
const MODEL_USAGE = { model: 'claude-test', ...USAGE }

function successResult(content: string, sessionId?: string): MessageChunk {
  return { type: 'result', content, usage: USAGE, modelUsages: [MODEL_USAGE], ...(sessionId ? { sessionId } : {}) }
}

beforeAll(() => {
  db = new Database(':memory:')
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  tokenUsageDao = new TokenUsageDAO(db)
})

beforeEach(() => {
  fs.mkdirSync(path.join(AGENT_DIR, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, 'experiences'), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(CLAUDE_DIR, 'projects'), { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM session_prompt_snapshots').run()
  db.prepare('DELETE FROM session_expert_rosters').run()
  db.prepare('DELETE FROM session_role_states').run()
  db.prepare('DELETE FROM llm_calls').run()
  script = []
  installProvider()
  initAgentService(sessionDAO, { insertSafetyEvent: vi.fn() } as never)
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION, title: 'T', clone_name: null, session_type: 'main',
    created_at: now, updated_at: now,
  })
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* non-fatal */ }
  db.close()
})

describe('斜杠命令 — 本地命令输出必须可见且收尾', () => {
  it('/context：result-only 正文下发、落库，并正常 done', async () => {
    script.push([
      { type: 'slash_commands', commands: ['compact', 'context', 'user-skill'] },
      successResult('## Context Usage\n\n**Tokens:** 1k / 200k', 'sdk-ctx'),
    ])

    const res = await chat('/context')
    const body = await res.text()

    expect(body).toContain('event: text_delta')
    expect(body).toContain('## Context Usage')
    expect(body).toContain('event: done')
    expect(body).toContain('event: slash_commands')

    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('## Context Usage\n\n**Tokens:** 1k / 200k')

    // init 命令集可从接口回读（刷新后 composer 菜单仍能画出来）。
    const commandsRes = await app().request(`/api/agent/sessions/${SESSION}/slash-commands`, { headers: HEADERS })
    expect(await commandsRes.json()).toEqual({ commands: ['compact', 'context', 'user-skill'] })
  })

  it('/compact：空正文仍发 done（不再让 composer 永转圈）', async () => {
    script.push([
      { type: 'status', status: 'compacting' },
      successResult('', 'sdk-compact'),
    ])

    const res = await chat('/compact')
    const body = await res.text()

    expect(body).toContain('event: status')
    expect(body).toContain('event: done')
    expect(assistantRows()).toHaveLength(0)
  })

  it('/clear：只清 provider 会话指针，聊天记录与 DB 行原样保留', async () => {
    // 先有一条真实转写，usableResumeId 才不会在请求入口就清掉指针。
    const transcriptDir = path.join(CLAUDE_DIR, 'projects', projectDirKey(AGENT_DIR))
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, 'sdk-old.jsonl'), '{}\n', 'utf-8')
    sessionDAO.updateProviderSession(SESSION, 'sdk-old')
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    ).run('hist-1', SESSION, '旧消息', new Date().toISOString())

    script.push([
      { type: 'conversation_reset' },
      successResult(''),
    ])

    const res = await chat('/clear')
    const body = await res.text()

    expect(body).toContain('event: done')
    expect(sessionDAO.findById(SESSION)?.provider_session_id).toBeNull()

    // 语义 A：历史与用户消息不动，/clear 不写 assistant 行。
    const history = db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user'",
    ).all(SESSION) as Array<{ content: string }>
    expect(history.map((m) => m.content)).toContain('旧消息')
    expect(history.map((m) => m.content)).toContain('/clear')
    expect(assistantRows()).toHaveLength(0)
  })

  it('/usage 保持 CLI 语义：正文来自 result.content，不经应用账本', async () => {
    script.push([successResult('Total cost:            $0.0000\nUsage: 0 input, 0 output')])

    const res = await chat('/usage')
    const body = await res.text()

    expect(body).toContain('Total cost:')
    expect(body).toContain('event: done')
    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain('Total cost:')
  })
})
