import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { createMainAgentRoute } from '../routes/agent/main-agent-route'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `delegate-mention-test-${Date.now()}`)

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
  } as any
}

// ── Tests ─────────────────────────────────────────────────────────

describe('@@mention Backend (delegate_to)', () => {
  let app: Hono

  beforeEach(() => {
    setOctopusHome()
    sessions.clear()
    messages.length = 0

    // Create test directory structure
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'workspace'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'scheduler'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'archive'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'resource'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'clones'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'memory'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'skills'), { recursive: true })

    // Write config + persona for built-in clones
    for (const [name, displayName] of [
      ['workspace', '全栈开发助手'],
      ['scheduler', '定时任务管理'],
      ['archive', '工程分析师'],
      ['resource', '资源操作专家'],
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

  describe('delegate_to validation', () => {
    it('returns error SSE for nonexistent clone', async () => {
      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', delegate_to: 'nonexistent-clone' }),
      })

      expect(res.status).toBe(200) // SSE always returns 200

      // Read SSE stream to find error event
      const text = await res.text()
      expect(text).toContain('CLONE_NOT_FOUND')
      expect(text).toContain('nonexistent-clone')
    })

    it('accepts delegate_to for built-in clone', async () => {
      // Mock getProvider to simulate provider unavailable (graceful error)
      const providers = await import('@octopus/providers')
      vi.spyOn(providers, 'getProvider').mockImplementation(() => {
        throw new Error('Provider not configured in test')
      })

      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'help me with cron', delegate_to: 'scheduler' }),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      // Should contain delegation_start event (clone exists)
      expect(text).toContain('delegation_start')
      expect(text).toContain('scheduler')
    })

    it('stores user message in session when delegate_to is present', async () => {
      const providers = await import('@octopus/providers')
      vi.spyOn(providers, 'getProvider').mockImplementation(() => {
        throw new Error('Provider not configured in test')
      })

      await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test message', delegate_to: 'scheduler' }),
      })

      // User message should be stored
      expect(messages.length).toBeGreaterThanOrEqual(1)
      expect(messages[0].content).toBe('test message')
      expect(messages[0].role).toBe('user')
    })

    it('returns error when message is missing', async () => {
      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegate_to: 'scheduler' }),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('self-reference', () => {
    it('treats delegate_to matching session clone_name as normal message', async () => {
      // Pre-create a session with clone_name = 'scheduler'
      const sessionId = 'test-session-self'
      sessions.set(sessionId, {
        id: sessionId,
        org: 'default',
        clone_name: 'scheduler',
        is_deleted: false,
        title: 'Scheduler 会话',
      })

      // When delegate_to matches session's clone_name, it should fall through
      // to normal LLM routing (which will fail in test because provider is unavailable)
      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', delegate_to: 'scheduler', session_id: sessionId }),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      // Should NOT contain delegation_start (self-reference = normal flow)
      expect(text).not.toContain('delegation_start')
    })
  })
})
