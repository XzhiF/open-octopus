import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { z } from 'zod'
import { ModelAliasConfigSchema, loadModelAliasConfig, LLM_CALL_SOURCE_PATHS } from '@octopus/shared'
import type { CustomProviderDef } from '@octopus/shared'
import { testConnectivity, resetProviderInstances, listProviders } from '@octopus/providers'
import type { ConnectivityResult } from '@octopus/providers'
import { getDb } from '../db/connection'
import { BillingDAO, BillingPriceValidationError } from '../db/dao/billing-dao'
import type { BillingPricePatch, BillingReportGroupBy, BillingReportRankBy } from '../db/dao/billing-dao'

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
  // Billing (billing NEW-r2) — /billing/prices CRUD + /billing/settings + /billing/price-preview
  // 价格表 = 规则表（兜底价全时段 + 时间段价半开区间，本地日界）；钱不落账本，
  // 一切费用查询时经 llm_calls_costed 视图现算 —— 改价立即重算全部历史（NEW-r2 翻转）。
  // 错误形状沿用本文件 { error: { code, message } } 惯例。
  // ============================================================================

  const billingDao = () => new BillingDAO(getDb())

  const billingCurrencySchema = z.enum(['USD', 'CNY'])
  /** 窗口边界：YYYY-MM-DD 日期串（服务端换本地零点 epoch ms）；null = 拆界；缺省 = 不动。 */
  const priceWindowBoundSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '需为 YYYY-MM-DD 日期').nullable()
  const priceCreateSchema = z.object({
    vendor: z.string().min(1),
    model_id: z.string().min(1),
    input_unit_price: z.number().nonnegative(),
    output_unit_price: z.number().nonnegative(),
    cache_write_unit_price: z.number().nonnegative(),
    cache_read_unit_price: z.number().nonnegative(),
    currency: billingCurrencySchema.default('CNY'),
    valid_from: priceWindowBoundSchema.optional(),
    valid_to: priceWindowBoundSchema.optional(),
  })
  const priceUpdateSchema = priceCreateSchema.partial()

  /** 日期串 → 本地零点 epoch ms。undefined = 缺省(不动)；null = 拆界；NaN = 非法日期。 */
  function priceDateToMs(raw: string | null | undefined): number | null | undefined {
    if (raw === undefined || raw === null) return raw
    const [y, m, d] = raw.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    if (m < 1 || m > 12 || d < 1 || d > 31 || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return NaN
    return dt.getTime()
  }

  /** body 的日期窗口字段 → epoch（保 null=拆界、缺省=不动）；'INVALID' = 日期非法。 */
  function priceWindowFromBody(body: { valid_from?: string | null; valid_to?: string | null }): { valid_from?: number | null; valid_to?: number | null } | 'INVALID' {
    const from = priceDateToMs(body.valid_from)
    const to = priceDateToMs(body.valid_to)
    if (Number.isNaN(from) || Number.isNaN(to)) return 'INVALID'
    return { valid_from: from, valid_to: to }
  }
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

  /** DAO/校验错误 → 带 code 的 4xx；非约束错误返回 null 交上层 500。 */
  function billingWriteErrorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown) {
    if (err instanceof BillingPriceValidationError) {
      return c.json({ error: { code: err.code, message: err.message } }, 400)
    }
    const msg = err instanceof Error ? err.message : String(err)
    // 部分唯一索引 ux_price_catchall 的竞态兜底（应用层校验已拦绝大数）
    if (/UNIQUE constraint failed: billing_price_config\.model_id/.test(msg)) {
      return c.json({ error: { code: 'PRICE_CATCHALL_DUPLICATE', message: `该模型已存在兜底价（每模型至多一条）: ${msg}` } }, 400)
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

  // POST /billing/prices — 新增（兜底价每模型一条；时间段行窗口互不重叠，违例 400）
  router.post('/billing/prices', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    const parsed = priceCreateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '价格配置校验失败', details: parsed.error.issues },
      }, 400)
    }
    const window = priceWindowFromBody(parsed.data)
    if (window === 'INVALID') {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'valid_from/valid_to 需为有效日期（YYYY-MM-DD）' } }, 400)
    }
    try {
      const { valid_from: _sf, valid_to: _st, ...fields } = parsed.data
      const price = billingDao().createPrice({ ...fields, ...window })
      return c.json({ price }, 201)
    } catch (err: unknown) {
      const mapped = billingWriteErrorResponse(c, err)
      if (mapped) return mapped
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'WRITE_FAILED', message: msg } }, 500)
    }
  })

  // PUT /billing/prices/:id — 就地改价（NEW-r2：规则表语义，改价立即重算全部历史账目）
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
    const window = priceWindowFromBody(parsed.data)
    if (window === 'INVALID') {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'valid_from/valid_to 需为有效日期（YYYY-MM-DD）' } }, 400)
    }
    try {
      const { valid_from: _uf, valid_to: _ut, ...fields } = parsed.data
      const price = billingDao().updatePrice(c.req.param('id'), { ...(fields as BillingPricePatch), ...window })
      if (!price) return c.json({ error: { code: 'NOT_FOUND', message: 'price config not found' } }, 404)
      return c.json({ price })
    } catch (err: unknown) {
      const mapped = billingWriteErrorResponse(c, err)
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

  // POST /billing/price-preview — 试算器（配价页的解释器）：
  // 模型 + 日期 + 四类 token → 命中价行与算出的钱。与账本/报表同一套匹配 SQL，
  // 公式零复制 —— 「为什么是这笔钱」永远答得和账一致。
  const previewSchema = z.object({
    model: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    timestamp: z.coerce.number().int().positive().optional(),
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    cache_creation_tokens: z.number().int().nonnegative().default(0),
    cache_read_tokens: z.number().int().nonnegative().default(0),
  })
  router.post('/billing/price-preview', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    const parsed = previewSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: '试算参数校验失败', details: parsed.error.issues } }, 400)
    }
    const q = parsed.data
    if (q.date === undefined && q.timestamp === undefined) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'date 与 timestamp 至少给一个' } }, 400)
    }
    const dateMs = priceDateToMs(q.date ?? undefined)
    if (Number.isNaN(dateMs)) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'date 需为有效日期（YYYY-MM-DD）' } }, 400)
    }
    try {
      const dao = billingDao()
      const result = dao.previewCost(q.model, q.timestamp ?? dateMs ?? 0, {
        inputTokens: q.input_tokens, outputTokens: q.output_tokens,
        cacheCreationTokens: q.cache_creation_tokens, cacheReadTokens: q.cache_read_tokens,
      })
      const rate = dao.getUsdToCny()
      const currency = dao.getDisplayCurrency()
      const factor = currency === 'CNY' ? rate : 1
      return c.json({
        ...result,
        cost_display: result.cost_usd === null ? null : result.cost_usd * factor,
        currency_rate: factor,
        display_currency: currency,
      })
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
    // billing-report-3 票04 联动下钻：session 排行条目 / 厂商分布条目 → 明细筛选注入
    session_id: z.string().min(1).optional(),
    vendor: z.string().min(1).optional(),
    // billing-coverage-2 票05 (KD20/KD26): 来源筛选（枚举外 400）；响应带当前筛选下各来源小计
    source_path: z.enum(LLM_CALL_SOURCE_PATHS).optional(),
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
      const filters = { model: q.model, priceStatus: q.price_status, workspaceId: q.workspace_id, sessionId: q.session_id, vendor: q.vendor, sourcePath: q.source_path, fromTs: q.from, toTs: q.to }
      const { rows, total } = dao.listCalls(filters, q.page_size, (q.page - 1) * q.page_size)
      return c.json({
        calls: rows, total, page: q.page, pageSize: q.page_size, models: dao.listCallModels(),
        source_subtotals: dao.sourceSubtotals(filters),
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  // ============================================================================
  // Billing report (billing-report-3 票02) — GET /billing/report/breakdown
  // 聚合单一真相源 = llm_calls（KD20），SQL 内 GROUP BY（KD22）；数量含 unpriced、
  // 费用仅 priced 且全未定价 = NULL（KD21/KD4）；出参 USD 基准 + 展示币种双字段，
  // 换算用服务端当时汇率（与明细页同源同规则，US6/KD7/KD8）。
  // ============================================================================

  /**
   * from/to 界值解析：YYYY-MM-DD（KD24 本地时区日界，含首尾日）或 epoch 毫秒。
   * 返回 undefined = 未提供（不设界）；null = 非法。
   */
  function reportDateBound(raw: string | undefined, edge: 'from' | 'to'): number | null | undefined {
    if (raw === undefined) return undefined
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [y, m, d] = raw.split('-').map(Number)
      const dt = new Date(y, m - 1, d)
      if (m < 1 || m > 12 || d < 1 || d > 31 || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
      // to 界 = 次日本地零点 - 1ms（DST 23h/25h 日均正确；与 billingReportRange 缺省路径同构）
      return edge === 'from' ? dt.getTime() : new Date(y, m - 1, d + 1).getTime() - 1
    }
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  function billingReportBounds(q: { from?: string; to?: string }): { fromTs?: number; toTs?: number } | null {
    const fromTs = reportDateBound(q.from, 'from')
    const toTs = reportDateBound(q.to, 'to')
    if (fromTs === null || toTs === null) return null
    return { fromTs: fromTs ?? undefined, toTs: toTs ?? undefined }
  }

  const breakdownQuerySchema = z.object({
    group_by: z.enum(['model', 'vendor', 'source']),
    from: z.string().optional(),
    to: z.string().optional(),
  })

  // GET /billing/report/breakdown — 费用分布（share 之和 = 1；无费用基准时全部记 0）
  router.get('/billing/report/breakdown', (c) => {
    const parsed = breakdownQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '查询参数校验失败', details: parsed.error.issues },
      }, 400)
    }
    const q = parsed.data
    const bounds = billingReportBounds(q)
    if (!bounds) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'from/to 需为 YYYY-MM-DD 日期或 epoch 毫秒' } }, 400)
    }
    if (bounds.fromTs !== undefined && bounds.toTs !== undefined && bounds.toTs < bounds.fromTs) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'to 不能早于 from' } }, 400)
    }
    try {
      const dao = billingDao()
      const groups = dao.reportBreakdown(q.group_by as BillingReportGroupBy, bounds.fromTs, bounds.toTs)
      const rate = dao.getUsdToCny()
      const currency = dao.getDisplayCurrency()
      const total = groups.reduce((s, g) => s + (g.cost_usd ?? 0), 0) // ledger-ok: share 分母专用 —— 全未定价组不贡献分母；各条目 cost_usd 仍保 NULL（KD4 不焊 0 仅限出参）
      const items = groups.map(g => ({
        key: g.key,
        cost_usd: g.cost_usd,
        cost_display: g.cost_usd === null ? null : (currency === 'CNY' ? g.cost_usd * rate : g.cost_usd),
        calls: g.calls,
        share: total > 0 && g.cost_usd !== null ? g.cost_usd / total : 0,
      }))
      return c.json({ items, group_by: q.group_by, display_currency: currency, usd_to_cny: rate })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  const rankingQuerySchema = z.object({
    by: z.enum(['workspace', 'session']),
    // KD25：Top N 默认 10，N>50 → 400（与 page_size 越界同款惯例，取"4xx"实现并一致）
    limit: z.coerce.number().int().min(1).max(50).default(10),
    from: z.string().optional(),
    to: z.string().optional(),
  })

  // GET /billing/report/ranking — 费用排行 Top N（口径同 breakdown）
  router.get('/billing/report/ranking', (c) => {
    const parsed = rankingQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '查询参数校验失败', details: parsed.error.issues },
      }, 400)
    }
    const q = parsed.data
    const bounds = billingReportBounds(q)
    if (!bounds) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'from/to 需为 YYYY-MM-DD 日期或 epoch 毫秒' } }, 400)
    }
    if (bounds.fromTs !== undefined && bounds.toTs !== undefined && bounds.toTs < bounds.fromTs) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'to 不能早于 from' } }, 400)
    }
    try {
      const dao = billingDao()
      const rows = dao.reportRanking(q.by as BillingReportRankBy, bounds.fromTs, bounds.toTs, q.limit)
      const rate = dao.getUsdToCny()
      const currency = dao.getDisplayCurrency()
      const items = rows.map(r => ({
        id: r.id,
        name: r.name,
        cost_usd: r.cost_usd,
        cost_display: r.cost_usd === null ? null : (currency === 'CNY' ? r.cost_usd * rate : r.cost_usd),
        calls: r.calls,
      }))
      return c.json({ items, by: q.by, limit: q.limit, display_currency: currency, usd_to_cny: rate })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  // ============================================================================
  // Billing report (billing-report-3 票01) — GET /billing/report/summary|trend
  // 出参形状 = 票面契约：summary { total_cost_usd, total_cost_display, total_calls,
  // tokens{in,out,cache_w,cache_r}, unpriced{calls,ratio}, currency_rate }；
  // trend 逐日 { date, cost_usd, cost_display, calls }，无调用日补 0。
  // 日期缺省 = 最近 30 天（含今日）；to < from → 400；空区间 → 全 0 结构非 404（AC2）。
  // currency_rate = USD→展示币种乘数（CNY 时 = usd_to_cny，USD 时 = 1；与明细页同汇率 US6/KD7/KD8）。
  // 聚合在 SQL（KD22）；费用排除 unpriced、数量含之（KD21）；本地日界（KD24，经 reportDateBound）。
  // ============================================================================

  const reportRangeSchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  })

  function localDayStr(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function shiftLocalDay(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    return localDayStr(new Date(y, m - 1, d + days))
  }

  /**
   * summary/trend 区间解析：from/to 可缺省 —— 缺省时 to = 今日、from = to 回拨 29 天
   * （"最近 30 天含今日"票面缺省）。null = 日期非法。
   */
  function billingReportRange(q: { from?: string; to?: string }):
    { fromTs: number; toTs: number; fromStr: string; toStr: string } | null {
    const fromProbe = reportDateBound(q.from, 'from')
    const toProbe = reportDateBound(q.to, 'to')
    if (fromProbe === null || toProbe === null) return null
    const toStr = toProbe === undefined ? localDayStr(new Date()) : localDayStr(new Date(toProbe))
    const fromStr = fromProbe === undefined ? shiftLocalDay(toStr, -29) : localDayStr(new Date(fromProbe))
    const [fy, fm, fd] = fromStr.split('-').map(Number)
    const [ty, tm, td] = toStr.split('-').map(Number)
    const fromTs = fromProbe ?? new Date(fy, fm - 1, fd).getTime()
    const toTs = toProbe ?? new Date(ty, tm - 1, td + 1).getTime() - 1
    return { fromTs, toTs, fromStr, toStr }
  }

  // GET /billing/report/summary — 区间汇总卡数据源（US1）
  router.get('/billing/report/summary', (c) => {
    const parsed = reportRangeSchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '查询参数校验失败', details: parsed.error.issues },
      }, 400)
    }
    const r = billingReportRange(parsed.data)
    if (!r) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'from/to 需为 YYYY-MM-DD 日期或 epoch 毫秒' } }, 400)
    }
    if (r.toTs < r.fromTs) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'to 不能早于 from' } }, 400)
    }
    try {
      const dao = billingDao()
      const s = dao.reportSummary(r.fromTs, r.toTs)
      const rate = dao.getUsdToCny()
      const currency = dao.getDisplayCurrency()
      const factor = currency === 'CNY' ? rate : 1
      return c.json({
        from: r.fromStr,
        to: r.toStr,
        total_cost_usd: s.total_cost_usd,
        total_cost_display: s.total_cost_usd === null ? null : s.total_cost_usd * factor,
        total_calls: s.total_calls,
        tokens: {
          in: s.input_tokens,
          out: s.output_tokens,
          cache_w: s.cache_creation_tokens,
          cache_r: s.cache_read_tokens,
        },
        unpriced: {
          calls: s.unpriced_calls,
          ratio: s.total_calls > 0 ? s.unpriced_calls / s.total_calls : 0,
        },
        currency_rate: factor,
        display_currency: currency,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  // GET /billing/report/trend — 逐日费用/调用数（US2；尖峰可辨识 = 数据本身，图表侧渲染）
  router.get('/billing/report/trend', (c) => {
    const parsed = reportRangeSchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_FAILED', message: '查询参数校验失败', details: parsed.error.issues },
      }, 400)
    }
    const r = billingReportRange(parsed.data)
    if (!r) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'from/to 需为 YYYY-MM-DD 日期或 epoch 毫秒' } }, 400)
    }
    if (r.toTs < r.fromTs) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'to 不能早于 from' } }, 400)
    }
    try {
      const dao = billingDao()
      const rows = dao.reportTrend(r.fromTs, r.toTs)
      const byDay = new Map(rows.map(x => [x.day, x]))
      const rate = dao.getUsdToCny()
      const currency = dao.getDisplayCurrency()
      const factor = currency === 'CNY' ? rate : 1
      const days: Array<{ date: string; cost_usd: number | null; cost_display: number | null; calls: number }> = []
      for (let cur = r.fromStr; ; cur = shiftLocalDay(cur, 1)) {
        const row = byDay.get(cur)
        days.push(row
          ? {
              date: cur,
              cost_usd: row.cost_usd,
              cost_display: row.cost_usd === null ? null : row.cost_usd * factor,
              calls: row.calls,
            }
          // 无调用日补 0（票面；区别于"有行但全 unpriced"的 NULL，KD4 不焊 0）
          : { date: cur, cost_usd: 0, cost_display: 0, calls: 0 })
        if (cur === r.toStr) break
      }
      return c.json({
        from: r.fromStr,
        to: r.toStr,
        currency_rate: factor,
        display_currency: currency,
        days,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'READ_FAILED', message: msg } }, 500)
    }
  })

  return router
}
