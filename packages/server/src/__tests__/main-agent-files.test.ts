import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Hono } from 'hono'
import { createMainAgentFilesRoutes } from '../routes/agent/main-agent-files'

const TEST_DIR = path.join(os.tmpdir(), `main-agent-files-test-${Date.now()}`)
const AGENT_DIR = path.join(TEST_DIR, 'agent')

function createApp(): Hono {
  const app = new Hono()
  app.route('/', createMainAgentFilesRoutes())
  return app
}

describe('Main Agent files API', () => {
  beforeEach(() => {
    process.env.OCTOPUS_HOME = TEST_DIR
    fs.mkdirSync(path.join(AGENT_DIR, 'memory', 'daily'), { recursive: true })
    fs.mkdirSync(path.join(AGENT_DIR, 'skills', 'octo-wiki'), { recursive: true })
    fs.writeFileSync(path.join(AGENT_DIR, 'persona.md'), '# 主 Agent\n', 'utf-8')
    fs.writeFileSync(path.join(AGENT_DIR, 'config.yaml'), 'model: claude/pro\n', 'utf-8')
    fs.writeFileSync(path.join(AGENT_DIR, 'memory', 'long-term.md'), '# 长期记忆\n', 'utf-8')
    fs.writeFileSync(path.join(AGENT_DIR, 'memory', 'daily', '2026-11-07.md'), '# 日记\n', 'utf-8')
    fs.writeFileSync(path.join(AGENT_DIR, 'skills', 'octo-wiki', 'SKILL.md'), '# skill\n', 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    delete process.env.OCTOPUS_HOME
  })

  it('lists the agent tree with readonly flags', async () => {
    const app = createApp()
    const res = await app.request('/files?recursive=true')
    expect(res.status).toBe(200)
    const body = await res.json() as { files: Array<{ path: string; type: string; readonly: boolean }> }

    const byPath = new Map(body.files.map((file) => [file.path, file]))
    expect(byPath.get('persona.md')?.readonly).toBe(false)
    expect(byPath.get('memory/long-term.md')?.readonly).toBe(false)
    expect(byPath.get('config.yaml')?.readonly).toBe(true)
    expect(byPath.get('memory/daily/2026-11-07.md')?.readonly).toBe(true)
    expect(byPath.get('skills/octo-wiki/SKILL.md')?.readonly).toBe(true)
    expect(byPath.get('memory')?.type).toBe('directory')
  })

  it('reads a single file', async () => {
    const app = createApp()
    const res = await app.request('/files/persona.md')
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string; readonly: boolean }
    expect(body.content).toContain('# 主 Agent')
    expect(body.readonly).toBe(false)
  })

  it('writes editable files and refuses system-managed files', async () => {
    const app = createApp()
    const write = await app.request('/files/persona.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# 新人格\n' }),
    })
    expect(write.status).toBe(200)
    expect(fs.readFileSync(path.join(AGENT_DIR, 'persona.md'), 'utf-8')).toBe('# 新人格\n')

    const blocked = await app.request('/files/config.yaml', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'model: x\n' }),
    })
    expect(blocked.status).toBe(403)
    expect(fs.readFileSync(path.join(AGENT_DIR, 'config.yaml'), 'utf-8')).toBe('model: claude/pro\n')
  })

  it('rejects path traversal', async () => {
    const app = createApp()
    const res = await app.request('/files/..%2F..%2Fetc%2Fpasswd')
    expect(res.status).toBe(400)
  })
})
