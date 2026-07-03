import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'

import { createServer } from '../server'
import { getTool } from '../tools'

// ─── Server lifecycle ─────────────────────────────

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://localhost:${port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

// ─── Helpers ──────────────────────────────────────

function fetch(path: string, init?: { method?: string; body?: string }): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const req = http.request(url, { method: init?.method ?? 'GET', headers: init?.body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          json: async () => JSON.parse(data),
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (init?.body) req.write(init.body)
    req.end()
  })
}

// ─── Tests ────────────────────────────────────────

describe('GET /health_check', () => {
  it('returns status ok', async () => {
    const res = await fetch('/health_check')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; uptime: number }
    expect(body.status).toBe('ok')
    expect(body.uptime).toBeGreaterThan(0)
  })
})

describe('GET /get_manifest', () => {
  it('returns agent manifest with tools', async () => {
    const res = await fetch('/get_manifest')
    expect(res.status).toBe(200)
    const manifest = await res.json() as {
      name: string
      protocol: string
      tools: Array<{ name: string; description: string }>
    }
    expect(manifest.name).toBe('baidu-map-provider')
    expect(manifest.protocol).toBe('pi-agent-core')
    expect(manifest.tools.length).toBeGreaterThan(0)
    expect(manifest.tools[0].name).toBe('baidu_geocode')
  })
})

describe('POST /execute_tool', () => {
  it('rejects missing tool_name', async () => {
    const res = await fetch('/execute_tool', {
      method: 'POST',
      body: JSON.stringify({ parameters: {} }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('tool_name')
  })

  it('rejects unknown tool', async () => {
    const res = await fetch('/execute_tool', {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'nonexistent', parameters: {} }),
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('not found')
  })

  it('rejects invalid parameters (missing address)', async () => {
    const res = await fetch('/execute_tool', {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'baidu_geocode', parameters: {} }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('address')
  })

  it('rejects invalid JSON body', async () => {
    const res = await fetch('/execute_tool', {
      method: 'POST',
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns error when BAIDU_MAP_AK is not set', async () => {
    const originalAk = process.env.BAIDU_MAP_AK
    delete process.env.BAIDU_MAP_AK

    const res = await fetch('/execute_tool', {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'baidu_geocode', parameters: { address: '北京市' } }),
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('BAIDU_MAP_AK')

    if (originalAk) process.env.BAIDU_MAP_AK = originalAk
  })
})

describe('404', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await fetch('/nonexistent')
    expect(res.status).toBe(404)
  })
})

describe('Tool registry', () => {
  it('baidu_geocode tool is registered', () => {
    const tool = getTool('baidu_geocode')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('baidu_geocode')
  })
})
