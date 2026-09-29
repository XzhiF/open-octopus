// Clone file management API tests — current contract (routes/agent/clone-files.ts).
//
// History: these routes originally lived in routes/clone/index.ts with a
// GET/PUT whitelist (persona.md, config.json only). File ops were moved to
// createCloneFilesRoutes() which supports the full recursive tree,
// __inherited__/ virtual paths, GET/POST/DELETE (no PUT), and readonly
// detection for inherited resources. This file tracks that contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { createCloneFilesRoutes } from '../routes/agent/clone-files'
import { createUserClone } from '../services/agent/clone-resolver'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `clone-files-test-${Date.now()}`)

function setOctopusHome(): void {
  process.env.OCTOPUS_HOME = TEST_DIR
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
    app.route('/', createCloneFilesRoutes())
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal
    }
  })

  describe('GET /clones/:name/files/:path', () => {
    it('reads persona.md from built-in clone', async () => {
      const res = await app.request('/clones/workspace/files/persona.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toContain('全栈开发助手')
      expect(body.path).toBe('persona.md')
      expect(body.size).toBeGreaterThan(0)
      expect(body.readonly).toBe(false)
    })

    it('reads config.json from built-in clone', async () => {
      const res = await app.request('/clones/workspace/files/config.json')
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

      const res = await app.request('/clones/test-clone/files/persona.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toContain('Custom persona content')
    })

    it('reads nested files (recursive path param)', async () => {
      const nestedDir = path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'notes')
      fs.mkdirSync(nestedDir, { recursive: true })
      fs.writeFileSync(path.join(nestedDir, 'todo.md'), '# TODO', 'utf-8')

      const res = await app.request('/clones/workspace/files/notes/todo.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toBe('# TODO')
    })

    it('returns 404 for nonexistent file', async () => {
      const res = await app.request('/clones/workspace/files/secret.txt')
      expect(res.status).toBe(404)
    })

    it('returns 404 for path traversal attempts', async () => {
      const res = await app.request('/clones/workspace/files/..%2F..%2Fetc%2Fpasswd')
      expect(res.status).toBe(404)
    })

    it('returns 404 for nonexistent clone', async () => {
      const res = await app.request('/clones/nonexistent/files/persona.md')
      expect(res.status).toBe(404)
    })

    it('marks files under inherited agent memory as readonly', async () => {
      const memoryDir = path.join(TEST_DIR, 'agent', 'memory')
      fs.mkdirSync(memoryDir, { recursive: true })
      fs.writeFileSync(path.join(memoryDir, 'long-term.md'), '# Memory', 'utf-8')

      const res = await app.request('/clones/workspace/files/__inherited__/memory/long-term.md')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content).toBe('# Memory')
      expect(body.readonly).toBe(true)
    })
  })

  describe('POST /clones/:name/files/:path (create/write)', () => {
    it('writes persona.md for built-in clone', async () => {
      const res = await app.request('/clones/workspace/files/persona.md', {
        method: 'POST',
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

      const res = await app.request('/clones/test-clone/files/config.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '{"display_name": "测试分身"}' }),
      })
      expect(res.status).toBe(200)

      const configPath = path.join(TEST_DIR, 'agent', 'clones', 'test-clone', 'config.json')
      expect(fs.existsSync(configPath)).toBe(true)
    })

    it('creates an empty file when content is missing', async () => {
      const res = await app.request('/clones/workspace/files/notes.md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)

      const notesPath = path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'notes.md')
      expect(fs.existsSync(notesPath)).toBe(true)
      expect(fs.readFileSync(notesPath, 'utf-8')).toBe('')
    })

    it('returns 403 for path traversal attempts', async () => {
      const res = await app.request('/clones/workspace/files/..%2Fescape.md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'nope' }),
      })
      expect(res.status).toBe(403)
      expect(fs.existsSync(path.join(TEST_DIR, 'agent', 'built-in', 'escape.md'))).toBe(false)
    })
  })

  describe('DELETE /clones/:name/files/:path', () => {
    it('deletes an existing file', async () => {
      const filePath = path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'scratch.md')
      fs.writeFileSync(filePath, 'scratch', 'utf-8')

      const res = await app.request('/clones/workspace/files/scratch.md', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('returns 403 for path traversal attempts', async () => {
      const res = await app.request('/clones/workspace/files/..%2Fpersona.md', { method: 'DELETE' })
      expect(res.status).toBe(403)
      // Original persona survives
      expect(
        fs.existsSync(path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'persona.md')),
      ).toBe(true)
    })
  })
})
