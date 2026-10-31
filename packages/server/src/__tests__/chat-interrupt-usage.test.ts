// packages/server/src/__tests__/chat-interrupt-usage.test.ts
//
// 2026-10-31 中断记账（路由侧契约）：
//   停止后路由不再 break，而是继续消费 provider 的收尾 error result ——
//   被中断轮的真实用量（usage/modelUsage）必须落进 llm_calls，
//   且标记 stop_reason='interrupted'，正文冻结在停止点，会话不丢。
//
// Anti-fake-run: 真 better-sqlite3 + applySchema，Hono app.request，fake provider
// 在 abortSignal 触发后按真实 SDK 的行为吐一条 error_during_execution result。

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
import * as providers from '@octopus/providers'

const ORG = 'E2E_TEST_chat_interrupt_usage'
const SESSION = 's-int-usage'
const ROOT = path.join(os.tmpdir(), `chat-interrupt-usage-${Date.now()}`)
const HOME = path.join(ROOT, 'octopus')
const CLAUDE_DIR = path.join(ROOT, 'claude')
const AGENT_DIR = path.join(HOME, 'agent')

const USAGE = { inputTokens: 245, outputTokens: 80, cacheReadTokens: 24064, cacheCreationTokens: 0 }
const MODEL_USAGE = { model: 'claude-test', ...USAGE }

let db: Database.Database
let sessionDAO: AgentSessionDAO
let tokenUsageDao: TokenUsageDAO
let behaviors: Array<'hang' | 'finish'>

function installProvider() {
  vi.spyOn(providers, 'getProvider').mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options: { abortSignal?: AbortSignal; interruptible?: boolean },
    ) {
      const mode = behaviors.shift() ?? 'finish'
      if (!options?.interruptible) throw new Error('chat must run interruptible (streaming input mode)')
      yield { type: 'text_delta', content: '半句输出' }
      if (mode === 'hang') {
        // 与真实 provider 相同：abortSignal → interrupt → 被中断轮仍产出 result。
        await new Promise<void>((resolve) => {
          if (options.abortSignal?.aborted) return resolve()
          options.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield {
          type: 'error',
          code: 'error_during_execution',
          message: 'interrupted',
          sdkTerminalReason: 'aborted_tools',
          numTurns: 1,
          usage: USAGE,
          modelUsages: [MODEL_USAGE],
        }
        return
      }
      yield { type: 'result', content: '好的，继续。', sessionId: 'sdk-1', usage: USAGE, modelUsages: [MODEL_USAGE] }
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

function stop() {
  return app().request(`/api/agent/sessions/${SESSION}/stop`, { method: 'POST', headers: HEADERS })
}

async function readUntilFirstDelta(res: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (!acc.includes('text_delta')) {
    const { value, done } = await reader.read()
    if (done) break
    acc += decoder.decode(value, { stream: true })
  }
  return reader
}

function assistantRows() {
  return db.prepare(
    "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC",
  ).all(SESSION) as Array<{ id: string; content: string; metadata: string | null }>
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
  behaviors = []
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

describe('中断轮记账 — 停止后继续消费 result', () => {
  it('stop → interrupted result 的用量落进 llm_calls（stop_reason=interrupted），正文冻结', async () => {
    behaviors.push('hang')
    const res = await chat('写一篇长文')
    expect(res.status).toBe(200)
    const reader = await readUntilFirstDelta(res)

    const stopped = await stop()
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toMatchObject({ success: true, partial_content_preserved: true })

    const rows = db.prepare('SELECT * FROM llm_calls WHERE session_id = ?').all(SESSION) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_path: 'global_chat',
      session_id: SESSION,
      model: 'claude-test',
      input_tokens: USAGE.inputTokens,
      output_tokens: USAGE.outputTokens,
      cache_read_tokens: USAGE.cacheReadTokens,
      cache_creation_tokens: 0,
      stop_reason: 'interrupted',
    })

    // 正文冻结在停止点 + 中断标记；中断行不挂 streaming。
    const msgs = assistantRows()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('半句输出')
    const meta = JSON.parse(msgs[0].metadata ?? '{}') as { interrupted?: boolean; streaming?: boolean }
    expect(meta.interrupted).toBe(true)
    expect(meta.streaming).toBeUndefined()

    // 会话照常可续聊。
    const session = db.prepare('SELECT is_deleted FROM sessions WHERE id = ?').get(SESSION) as { is_deleted: number }
    expect(session.is_deleted).toBe(0)

    try { await reader.cancel() } catch { /* already closed */ }
  })

  it('正常收尾仍按 end_turn 落账（对比基准，不回归）', async () => {
    behaviors.push('finish')
    const res = await chat('你好')
    await res.text()

    const rows = db.prepare('SELECT * FROM llm_calls WHERE session_id = ?').all(SESSION) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ stop_reason: 'end_turn', input_tokens: USAGE.inputTokens })
  })
})
