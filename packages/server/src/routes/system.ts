import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { z } from 'zod'
import { ModelAliasConfigSchema, loadModelAliasConfig } from '@octopus/shared'
import type { CustomProviderDef } from '@octopus/shared'
import { testConnectivity, resetProviderInstances, listProviders } from '@octopus/providers'
import type { ConnectivityResult } from '@octopus/providers'

const DEFAULT_TEMPLATE = `# Octopus 模型配置
# 编辑后保存即可生效，无需重启
default: pro

providers:
  claude:
    pro-max: opus
    pro: sonnet
    se: haiku
  pi:
    pro-max: dashscope/qwen3.7-max
    pro: dashscope/qwen3.7-plus
    se: dashscope/qwen3.6-plus

custom_providers: {}
`

// ponytail: resolved per-call so tests can override process.env.HOME
function getModelsYamlPath(): string {
  return path.join(process.env.HOME ?? '~', '.octopus', 'models.yaml')
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function createSystemRoutes(): Hono {
  const router = new Hono()

  // GET /models — read ~/.octopus/models.yaml content
  router.get('/models', (c) => {
    const modelsPath = getModelsYamlPath()
    try {
      if (fs.existsSync(modelsPath)) {
        const content = fs.readFileSync(modelsPath, 'utf-8')
        return c.json({ content, path: modelsPath })
      }
      return c.json({ content: DEFAULT_TEMPLATE, path: modelsPath })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  // PUT /models — validate + atomic write + .bak + cache clear
  router.put('/models', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    const bodySchema = z.object({ content: z.string() })
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'INVALID_PARAM', message: 'content field required', details: parsed.error.issues },
      }, 400)
    }

    const rawContent = parsed.data.content

    // Zod validation
    let yamlData: unknown
    try {
      yamlData = yaml.load(rawContent)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({
        error: { code: 'YAML_PARSE_ERROR', message: `YAML syntax error: ${msg}` },
      }, 400)
    }

    const validated = ModelAliasConfigSchema.safeParse(yamlData)
    if (!validated.success) {
      return c.json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Schema validation failed',
          details: validated.error.issues.map(i => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
      }, 400)
    }

    // Re-serialize to normalized YAML
    const normalized = yaml.dump(validated.data, { indent: 2, lineWidth: 120 })

    // Atomic write: .bak + .tmp + rename
    const modelsPath = getModelsYamlPath()
    try {
      ensureDir(modelsPath)

      // .bak = content BEFORE this write
      if (fs.existsSync(modelsPath)) {
        fs.copyFileSync(modelsPath, modelsPath + '.bak')
      }

      const tmpPath = modelsPath + '.tmp'
      try {
        fs.writeFileSync(tmpPath, normalized, 'utf-8')
        fs.renameSync(tmpPath, modelsPath)
      } catch (renameErr) {
        // Clean up .tmp on rename failure
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
        throw renameErr
      }

      // Clear provider cache so new config takes effect
      try { resetProviderInstances() } catch { /* ignore */ }

      return c.json({ success: true, path: modelsPath })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'WRITE_FAILED', message: msg } }, 500)
    }
  })

  // POST /models/test — single provider connectivity test
  router.post('/models/test', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    const schema = z.object({
      provider: z.string(),
      model: z.string().optional(),
    })
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'INVALID_PARAM', message: 'provider field required', details: parsed.error.issues },
      }, 400)
    }

    const { provider, model } = parsed.data

    // Mock mode for automated tests
    if (process.env.OCTOPUS_MOCK_PROVIDERS === '1') {
      return c.json({
        provider, model,
        success: true,
        latency: Math.floor(Math.random() * 300) + 100,
      } as ConnectivityResult)
    }

    // Resolve custom provider definition from current config
    let customDef: CustomProviderDef | undefined
    try {
      const config = loadModelAliasConfig()
      const cp = config.custom_providers?.[provider]
      if (cp) customDef = cp
    } catch { /* use undefined */ }

    const result = await testConnectivity(provider, model, customDef)
    return c.json(result)
  })

  // POST /models/test-all — test all configured providers
  router.post('/models/test-all', async (c) => {
    // Mock mode
    if (process.env.OCTOPUS_MOCK_PROVIDERS === '1') {
      const results: ConnectivityResult[] = listProviders().map(p => ({
        provider: p,
        success: true,
        latency: Math.floor(Math.random() * 300) + 100,
      }))
      return c.json({ results })
    }

    let config
    try {
      config = loadModelAliasConfig()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'CONFIG_LOAD_FAILED', message: msg } }, 500)
    }

    const results: ConnectivityResult[] = []

    // Test registered providers
    for (const provider of listProviders()) {
      const result = await testConnectivity(provider)
      results.push(result)
    }

    // Test custom providers
    for (const [name, def] of Object.entries(config.custom_providers ?? {})) {
      const result = await testConnectivity(name, undefined, def)
      results.push(result)
    }

    return c.json({ results })
  })

  return router
}
