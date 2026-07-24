import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { createCloneSessionRoutes } from '../routes/clone/index'
import { createUserClone } from '../services/agent/clone-resolver'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `clone-files-test-${Date.now()}`)

function setOctopusHome(): void {
  process.env.OCTOPUS_HOME = TEST_DIR
}

/** Minimal mock AgentSessionDAO — only methods used by session routes */
function createMockSessionDAO() {
  return {
    insertSession: () => {},
    findById: () => null,
    findByClone: () => ({ items: [], has_more: false, next_cursor: null }),
    findMessagesBySession: () => ({ items: [], has_more: false, next_cursor: null }),
    insertCloneMessage: () => {},
    updateLastMessageAt: () => {},
    updateProviderSession: () => {},
    updateSession: () => {},
  } as any
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Clone File Management API', () => {
  let app: Hono

  beforeEach(() => {
    setOctopusHome()
    // Create test directory structure
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'workspace'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'scheduler'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'archive'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'resource'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'clones'), { recursive: true })

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
    }

    app = new Hono()
    app.route('/', createCloneSessionRoutes({ sessionDAO: createMockSessionDAO() }))
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal
    }
  })

  describe('GET /:name/files/:path', () => {
    it('reads persona.md from built-in clone', async () => {
      const res = await app.request('/workspace/files/persona.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toContain('全栈开发助手')
      expect(body.path).toBe('persona.md')
      expect(body.size).toBeGreaterThan(0)
    })

    it('reads config.json from built-in clone', async () => {
      const res = await app.request('/workspace/files/config.json')
      expect(res.status).toBe(200)
      const body = await res.json()
      const config = JSON.parse(body.content)
      expect(config.display_name).toBe('全栈开发助手')
    })

    it('reads persona.md from user clone', async () => {
      createUserClone({
        name: 'test-clone',
        display_name: '测试分身',
        persona: '# Test Clone\n\nCustom persona content',
      })

      const res = await app.request('/test-clone/files/persona.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toContain('Custom persona content')
    })

    it('returns 403 for non-whitelisted paths', async () => {
      const res = await app.request('/workspace/files/secret.txt')
      expect(res.status).toBe(403)
    })

    it('returns 403 for path traversal attempts', async () => {
      const res = await app.request('/workspace/files/..%2F..%2Fetc%2Fpasswd')
      expect(res.status).toBe(403)
    })

    it('returns 403 for paths with slashes', async () => {
      const res = await app.request('/workspace/files/memory%2Fdailymd')
      expect(res.status).toBe(403)
    })

    it('returns 404 for nonexistent clone', async () => {
      const res = await app.request('/nonexistent/files/persona.md')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /:name/files/:path', () => {
    it('writes persona.md for built-in clone', async () => {
      const res = await app.request('/workspace/files/persona.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# Updated Persona\n\nNew content' }),
      })
      expect(res.status).toBe(200)

      // Verify file was written
      const personaPath = path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'persona.md')
      const content = fs.readFileSync(personaPath, 'utf-8')
      expect(content).toContain('New content')
    })

    it('writes config.json for user clone', async () => {
      createUserClone({
        name: 'test-clone',
        display_name: '测试分身',
        persona: 'Original persona',
      })

      const res = await app.request('/test-clone/files/persona.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# Updated\n\nModified persona' }),
      })
      expect(res.status).toBe(200)
    })

    it('returns 403 for non-whitelisted paths', async () => {
      const res = await app.request('/workspace/files/secret.txt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'bad' }),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 when content is missing', async () => {
      const res = await app.request('/workspace/files/persona.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 for nonexistent clone', async () => {
      const res = await app.request('/nonexistent/files/persona.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test' }),
      })
      expect(res.status).toBe(404)
    })
  })
})
