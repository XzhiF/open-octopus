// Clone file API —— 当前实现面（routes/agent/clone-files.ts）。
//
// 历史：文件路由曾挂在 createCloneSessionRoutes 下、只允许 persona.md / config.json
// 白名单；v50 之后文件树 API 独立成 clone-files.ts（分身目录内任意文件可编辑，
// 只读区 = 继承的 skills/ memory/）。本测试随路由一起迁移，并钉住写路径的两个新
// 契约：① PUT 真的落盘（Web `updateCloneFile` 一直用 PUT，此前 404）；② 每次写
// 都追加一条 CHANGES.jsonl（「今日」页的分身资产变更来源）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { createCloneFilesRoutes } from '../routes/agent/clone-files'
import { createUserClone } from '../services/agent/clone-resolver'
import { readCloneChanges } from '../services/agent/clone-changes'

const TEST_DIR = path.join(os.tmpdir(), `clone-files-test-${Date.now()}`)

function builtInDir(name: string): string {
  return path.join(TEST_DIR, 'agent', 'built-in', name)
}

describe('Clone File Management API', () => {
  let app: Hono

  beforeEach(() => {
    process.env.OCTOPUS_HOME = TEST_DIR
    fs.mkdirSync(builtInDir('workspace'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'clones'), { recursive: true })

    fs.writeFileSync(
      path.join(builtInDir('workspace'), 'config.json'),
      JSON.stringify({ name: 'workspace', display_name: '全栈开发助手', type: 'built-in', skills: [], memoryScope: 'shared' }),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(builtInDir('workspace'), 'persona.md'),
      '# 全栈开发助手\n\nPersona for workspace',
      'utf-8',
    )

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
      const body = await res.json() as { content: string; path: string; size: number; readonly: boolean }
      expect(body.content).toContain('全栈开发助手')
      expect(body.path).toBe('persona.md')
      expect(body.size).toBeGreaterThan(0)
      expect(body.readonly).toBe(false)
    })

    it('reads config.json from built-in clone', async () => {
      const res = await app.request('/clones/workspace/files/config.json')
      expect(res.status).toBe(200)
      const body = await res.json() as { content: string }
      expect(JSON.parse(body.content).display_name).toBe('全栈开发助手')
    })

    it('reads persona.md from user clone', async () => {
      createUserClone({
        name: 'test-clone',
        display_name: '测试分身',
        persona: '# Test Clone\n\nCustom persona content',
      })

      const res = await app.request('/clones/test-clone/files/persona.md')
      expect(res.status).toBe(200)
      const body = await res.json() as { content: string }
      expect(body.content).toContain('Custom persona content')
    })

    it('marks inherited skills/memory as readonly', async () => {
      const skillsDir = path.join(TEST_DIR, 'agent', 'skills', 'octo-demo')
      fs.mkdirSync(skillsDir, { recursive: true })
      fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# demo', 'utf-8')

      const res = await app.request('/clones/workspace/files/__inherited__/skills/octo-demo/SKILL.md')
      expect(res.status).toBe(200)
      const body = await res.json() as { content: string; readonly: boolean }
      expect(body.content).toContain('# demo')
      expect(body.readonly).toBe(true)
    })

    it('returns 404 for a missing file', async () => {
      const res = await app.request('/clones/workspace/files/missing.txt')
      expect(res.status).toBe(404)
    })

    it('returns 404 for a nonexistent clone', async () => {
      const res = await app.request('/clones/nonexistent/files/persona.md')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /clones/:name/files/:path', () => {
    it('writes persona.md for a built-in clone and records a change entry', async () => {
      const res = await app.request('/clones/workspace/files/persona.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# Updated Persona\n\nNew content' }),
      })
      expect(res.status).toBe(200)

      const content = fs.readFileSync(path.join(builtInDir('workspace'), 'persona.md'), 'utf-8')
      expect(content).toContain('New content')

      const changes = readCloneChanges(builtInDir('workspace'))
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ kind: 'file', path: 'persona.md' })
      expect(typeof changes[0].delta_chars).toBe('number')
    })

    it('writes a nested file for a user clone', async () => {
      createUserClone({
        name: 'test-clone',
        display_name: '测试分身',
        persona: 'Original persona',
      })

      const res = await app.request('/clones/test-clone/files/notes/todo.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '- [ ] ship it' }),
      })
      expect(res.status).toBe(200)

      const userDir = path.join(TEST_DIR, 'agent', 'clones', 'test-clone')
      expect(fs.readFileSync(path.join(userDir, 'notes', 'todo.md'), 'utf-8')).toBe('- [ ] ship it')
      expect(readCloneChanges(userDir)[0]).toMatchObject({ kind: 'file', path: 'notes/todo.md', delta_chars: 13 })
    })

    it('rejects readonly inherited paths', async () => {
      const res = await app.request('/clones/workspace/files/__inherited__/memory/long-term.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'nope' }),
      })
      expect(res.status).toBe(403)
    })

    it('rejects path traversal', async () => {
      const res = await app.request('/clones/workspace/files/..%2F..%2Fetc%2Fpasswd', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'bad' }),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 when content is missing', async () => {
      const res = await app.request('/clones/workspace/files/persona.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })
  })
})