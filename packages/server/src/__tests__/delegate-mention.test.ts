// Main-agent legacy endpoint (/api/agent/chat) — delegate_to 已退役（v59）。
//
// 分身的两条出路现在是「切换身份（chip）」与「委派会诊（@ / 挂载面板）」，
// 整轮转交不再由用户面产生。旧客户端仍可能带上 delegate_to 字段 —— 该字段被
// 忽略，消息走正常 LLM 路由（不再有 delegation_start / clone_chat 落账）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { createMainAgentRoute } from '../routes/agent/main-agent-route'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `delegate-retired-test-${Date.now()}`)

function setOctopusHome(): void {
  process.env.OCTOPUS_HOME = TEST_DIR
}

/** Mock session store */
const sessions = new Map<string, any>()
const messages: any[] = []

function createMockSessionDAO() {
  return {
    insertSession: (row: any) => { sessions.set(row.id, { ...row, is_deleted: false }) },
    findById: (id: string) => sessions.get(id) ?? null,
    findSessionById: (id: string) => sessions.get(id) ?? null,
    insertMessage: (row: any) => { messages.push(row) },
    updateLastMessageAt: (id: string, at: string) => {
      const s = sessions.get(id)
      if (s) s.last_message_at = at
    },
    updateSession: (id: string, fields: any) => {
      const s = sessions.get(id)
      if (s) Object.assign(s, fields)
    },
    updateProviderSession: () => {},
    clearProviderSession: () => {},
  } as any
}

// ── Tests ─────────────────────────────────────────────────────────

describe('delegate_to 退役（legacy main-agent endpoint）', () => {
  let app: Hono

  beforeEach(() => {
    setOctopusHome()
    sessions.clear()
    messages.length = 0

    // Create test directory structure
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'workspace'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'scheduler'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'clones'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'memory'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'skills'), { recursive: true })

    for (const [name, displayName] of [
      ['workspace', '全栈开发助手'],
      ['scheduler', '定时任务管理'],
    ]) {
      fs.writeFileSync(
        path.join(TEST_DIR, 'agent', 'built-in', name, 'config.json'),
        JSON.stringify({ name, display_name: displayName, type: 'built-in', skills: [], memoryScope: 'shared' }),
        'utf-8',
      )
      fs.writeFileSync(
        path.join(TEST_DIR, 'agent', 'built-in', name, 'persona.md'),
        `# ${displayName}\n\nPersona for ${name}`,
        'utf-8',
      )
      fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', name, 'memory'), { recursive: true })
    }

    app = new Hono()
    app.route('/', createMainAgentRoute({ sessionDAO: createMockSessionDAO() }))
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    vi.restoreAllMocks()
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal
    }
  })

  it('ignores delegate_to and routes through the normal LLM turn (no delegation events)', async () => {
    const providers = await import('@octopus/providers')
    vi.spyOn(providers, 'getProvider').mockImplementation((() => ({
      sendQuery: async function* () {
        yield { type: 'text_delta', content: 'ok' }
        yield { type: 'result', content: 'ok', sessionId: 'sdk-1' }
      },
    })) as never)

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'help me with cron', delegate_to: 'scheduler' }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('delegation_start')
    expect(text).not.toContain('delegation_end')
    // The user message is stored raw; no assistant row carries a delegation marker.
    expect(messages.some((m) => m.role === 'user' && m.content === 'help me with cron')).toBe(true)
    expect(messages.every((m) => !/"?delegation"?\s*:\s*true/.test(String(m.metadata ?? '')))).toBe(true)
  })

  it('returns 400 when message is missing', async () => {
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delegate_to: 'scheduler' }),
    })

    expect(res.status).toBe(400)
  })
})