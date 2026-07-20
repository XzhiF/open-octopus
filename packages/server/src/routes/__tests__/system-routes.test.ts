import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createSystemRoutes } from '../system'
import { resetProviderInstances, registerProvider, ClaudeSDKProvider, PiAgentProvider } from '@octopus/providers'

describe('System Routes — /api/system/models', () => {
  let tmpDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-system-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpDir
    fs.mkdirSync(path.join(tmpDir, '.octopus'), { recursive: true })
    resetProviderInstances()
    // Register providers so listProviders() is non-empty for test-all
    registerProvider('pi', () => new PiAgentProvider())
    registerProvider('claude', () => new ClaudeSDKProvider())
  })

  afterEach(() => {
    process.env.HOME = originalHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.OCTOPUS_MOCK_PROVIDERS
  })

  const modelsPath = () => path.join(tmpDir, '.octopus', 'models.yaml')

  // getModelsYamlPath() resolves lazily per request, so a single route
  // instance works across HOME changes.
  const app = createSystemRoutes()

  // ── GET /models ────────────────────────────────────────────────────────

  describe('GET /models', () => {
    it('returns default template when file does not exist', async () => {
      const res = await app.request('/models')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.path).toBe(modelsPath())
      expect(data.content).toContain('default: pro')
    })

    it('returns existing file content', async () => {
      fs.writeFileSync(modelsPath(), 'default: se\nproviders: {}\ncustom_providers: {}\n', 'utf-8')
      const res = await app.request('/models')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.content).toContain('default: se')
    })
  })

  // ── PUT /models ────────────────────────────────────────────────────────

  describe('PUT /models', () => {
    it('returns 400 for invalid JSON body', async () => {
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when content field is missing', async () => {
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe('INVALID_PARAM')
    })

    it('returns 400 for YAML syntax error', async () => {
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: ':\n  - :\n  bad: [yaml' }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe('YAML_PARSE_ERROR')
    })

    it('returns 400 with Zod details for schema validation failure', async () => {
      // providers should be a record of records, not a string
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'default: pro\nproviders: "not-a-record"\ncustom_providers: {}\n' }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe('VALIDATION_FAILED')
      expect(Array.isArray(data.error.details)).toBe(true)
      expect(data.error.details.length).toBeGreaterThan(0)
      // File must not be written
      expect(fs.existsSync(modelsPath())).toBe(false)
    })

    it('writes file atomically and creates .bak on success', async () => {
      // Pre-existing content
      const original = 'default: se\nproviders: {}\ncustom_providers: {}\n'
      fs.writeFileSync(modelsPath(), original, 'utf-8')

      const newContent = 'default: pro\nproviders: {}\ncustom_providers: {}\n'
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.path).toBe(modelsPath())

      // .bak should contain original content
      const bakPath = modelsPath() + '.bak'
      expect(fs.existsSync(bakPath)).toBe(true)
      expect(fs.readFileSync(bakPath, 'utf-8')).toBe(original)

      // Target file should contain new content
      expect(fs.readFileSync(modelsPath(), 'utf-8')).toContain('default: pro')

      // No .tmp residue
      expect(fs.existsSync(modelsPath() + '.tmp')).toBe(false)
    })

    it('does not generate .bak when file does not previously exist', async () => {
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'default: pro\nproviders: {}\ncustom_providers: {}\n' }),
      })
      expect(res.status).toBe(200)
      expect(fs.existsSync(modelsPath())).toBe(true)
      expect(fs.existsSync(modelsPath() + '.bak')).toBe(false)
    })

    it('does not leave .tmp file when rename fails', async () => {
      // Simulate rename failure by making the target a directory (renameSync will fail)
      fs.mkdirSync(modelsPath())
      const res = await app.request('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'default: pro\nproviders: {}\ncustom_providers: {}\n' }),
      })
      // Should fail
      expect(res.status).toBe(500)
      // .tmp should be cleaned up
      expect(fs.existsSync(modelsPath() + '.tmp')).toBe(false)
      // Clean up the directory we created
      fs.rmdirSync(modelsPath())
    })
  })

  // ── POST /models/test ─────────────────────────────────────────────────

  describe('POST /models/test', () => {
    it('returns 400 when provider is missing', async () => {
      const res = await app.request('/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('returns mock success when OCTOPUS_MOCK_PROVIDERS=1', async () => {
      process.env.OCTOPUS_MOCK_PROVIDERS = '1'
      const res = await app.request('/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'pi', model: 'pro' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.provider).toBe('pi')
      expect(data.latency).toBeGreaterThanOrEqual(100)
    })

    it('reports env_key missing for custom provider', async () => {
      // Write a models.yaml with a custom provider requiring an env var
      const config = `default: pro
providers: {}
custom_providers:
  mytest:
    base_url: https://api.example.com
    env_key: MY_TEST_API_KEY
    models:
      - id: test-model
`
      fs.writeFileSync(modelsPath(), config, 'utf-8')
      // Ensure env key is NOT set
      delete process.env.MY_TEST_API_KEY

      const res = await app.request('/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'mytest' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(false)
      expect(data.error).toContain('MY_TEST_API_KEY')
    })
  })

  // ── POST /models/test-all ─────────────────────────────────────────────

  describe('POST /models/test-all', () => {
    it('returns mock results when OCTOPUS_MOCK_PROVIDERS=1', async () => {
      process.env.OCTOPUS_MOCK_PROVIDERS = '1'
      const res = await app.request('/models/test-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(Array.isArray(data.results)).toBe(true)
      expect(data.results.length).toBeGreaterThan(0)
      for (const r of data.results) {
        expect(r.success).toBe(true)
        expect(r.latency).toBeGreaterThanOrEqual(100)
      }
    })
  })
})
