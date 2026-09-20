import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { z } from 'zod'
import { ModelAliasConfigSchema, loadModelAliasConfig } from '@octopus/shared'
import type { CustomProviderDef } from '@octopus/shared'
import { testConnectivity, resetProviderInstances, listProviders } from '@octopus/providers'
import type { ConnectivityResult } from '@octopus/providers'
import { getDb } from '../db/connection'
import { BillingDAO } from '../db/dao/billing-dao'
import type { BillingPricePatch } from '../db/dao/billing-dao'

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

  // ============================================================================
  // Billing (billing-core-1 票03) — /billing/prices CRUD + /billing/settings
  // 数据层 = billing-dao (票01)；错误形状沿用本文件 { error: { code, message } } 惯例。
  // 响应字段名 = billing_price_config/billing_setting 行形状（web-app 契约，AC3）。
  // ============================================================================

  const billingDao = () => new BillingDAO(getDb())

  const billingCurrencySchema = z.enum(['USD', 'CNY'])
  const priceCreateSchema = z.object({
    vendor: z.string().min(1),
    model_id: z.string().min(1),
    input_unit_price: z.number().nonnegative(),
    output_unit_price: z.number().nonnegative(),
    cache_write_unit_price: z.number().nonnegative(),
    cache_read_unit_price: z.number().nonnegative(),
    currency: billingCurrencySchema.default('CNY'),
  })
  const priceUpdateSchema = priceCreateSchema.partial()
  const settingsPutSchema = z.object({
    usd_to_cny: z.union([z.number(), z.string()]),
    display_currency: billingCurrencySchema,
  }).partial()

  /** 读 JSON body；语法错误 → 400 INVALID_PARAM。返回 null = 调用方直接 return。 */
  async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
    try {
      return await c.req.json()
    } catch {
      return null
    }
  }

  /** DAO 抛出的 SqliteError → 带 code 的 4xx；非约束错误返回 null 交上层 500。 */
  function billingSqliteErrorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/UNIQUE constraint failed: billing_price_config\.model_id/.test(msg)) {
      return c.json({ error: { code: 'DUPLICATE_MODEL_ID', message: `model_id 已存在价格配置: ${msg}` } }, 409)
    }
    if (/CHECK constraint failed/.test(msg)) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: msg } }, 400)
    }
    return null
  }

  // GET /billing/prices — 列表（含 vendor 分组所需字段）
  router.get('/billing/prices', (c) => {
    try {
      return c.json({ prices: billingDao().listPrices() })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  // POST /billing/prices — 新增（model_id 唯一，冲突 409 带 code）
  router.post('/billing/prices', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    const parsed = priceCreateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '价格配置校验失败', details: parsed.error.issues },
      }, 400)
    }
    try {
      const price = billingDao().createPrice(parsed.data)
      return c.json({ price }, 201)
    } catch (err: unknown) {
      const mapped = billingSqliteErrorResponse(c, err)
      if (mapped) return mapped
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'WRITE_FAILED', message: msg } }, 500)
    }
  })

  // PUT /billing/prices/:id — 改价（改/删只影响新调用 KD3，历史行由记账快照保证）
  router.put('/billing/prices/:id', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    const parsed = priceUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '价格配置校验失败', details: parsed.error.issues },
      }, 400)
    }
    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'no fields to update' } }, 400)
    }
    try {
      const price = billingDao().updatePrice(c.req.param('id'), parsed.data as BillingPricePatch)
      if (!price) return c.json({ error: { code: 'NOT_FOUND', message: 'price config not found' } }, 404)
      return c.json({ price })
    } catch (err: unknown) {
      const mapped = billingSqliteErrorResponse(c, err)
      if (mapped) return mapped
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'WRITE_FAILED', message: msg } }, 500)
    }
  })

  // DELETE /billing/prices/:id
  router.delete('/billing/prices/:id', (c) => {
    try {
      const deleted = billingDao().deletePrice(c.req.param('id'))
      if (!deleted) return c.json({ error: { code: 'NOT_FOUND', message: 'price config not found' } }, 404)
      return c.json({ success: true, id: c.req.param('id') })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'WRITE_FAILED', message: msg } }, 500)
    }
  })

  // GET /billing/settings — 全局计费设置（内置键含默认值兜底）
  router.get('/billing/settings', (c) => {
    try {
      return c.json(billingDao().getAllSettings())
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  // PUT /billing/settings — 汇率 >0、display_currency ∈ {USD,CNY}；即时生效（KD7）
  router.put('/billing/settings', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    const parsed = settingsPutSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '设置校验失败', details: parsed.error.issues },
      }, 400)
    }
    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'no fields to update' } }, 400)
    }
    if (parsed.data.usd_to_cny !== undefined) {
      const rate = Number(parsed.data.usd_to_cny)
      if (!Number.isFinite(rate) || rate <= 0) {
        return c.json({
          error: { code: 'INVALID_PARAM', message: 'usd_to_cny 必须是 > 0 的数值', details: [{ path: ['usd_to_cny'], received: parsed.data.usd_to_cny }] },
        }, 400)
      }
    }
    try {
      const dao = billingDao()
      if (parsed.data.usd_to_cny !== undefined) dao.setSetting('usd_to_cny', String(parsed.data.usd_to_cny))
      if (parsed.data.display_currency !== undefined) dao.setSetting('display_currency', parsed.data.display_currency)
      return c.json(dao.getAllSettings())
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'WRITE_FAILED', message: msg } }, 500)
    }
  })

  // ============================================================================
  // Billing calls (billing-core-1 票06) — GET /billing/calls 分页流水
  // 只读 llm_calls（票 04 写入口落库的快照列原样透出）；展示币种换算在 web-app
  // 纯函数做（KD8：明细按当前汇率折算展示，历史不锁汇）。
  // ============================================================================

  const callsQuerySchema = z.object({
    model: z.string().min(1).optional(),
    price_status: z.enum(['priced', 'unpriced']).optional(),
    workspace_id: z.string().min(1).optional(),
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(50),
  })

  router.get('/billing/calls', (c) => {
    const parsed = callsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '查询参数校验失败', details: parsed.error.issues },
      }, 400)
    }
    const q = parsed.data
    try {
      const dao = billingDao()
      const { rows, total } = dao.listCalls(
        { model: q.model, priceStatus: q.price_status, workspaceId: q.workspace_id, fromTs: q.from, toTs: q.to },
        q.page_size,
        (q.page - 1) * q.page_size,
      )
      return c.json({ calls: rows, total, page: q.page, pageSize: q.page_size, models: dao.listCallModels() })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  return router
}
