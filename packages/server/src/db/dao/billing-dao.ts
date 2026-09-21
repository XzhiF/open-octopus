import type Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { BaseDAO } from "./base"

/**
 * BillingDAO — 计费数据层（billing-core-1 ticket 01）。
 *
 * 覆盖两张表：
 *   - billing_price_config：按 厂商+模型ID 的四类 token 单价（金额 / 1M tokens，KD6），
 *     model_id 全表唯一（KD9 精确匹配的真相源），币种 USD|CNY。
 *   - billing_setting：全局 key/value —— usd_to_cny（手工汇率 1 USD = N CNY，KD7）、
 *     display_currency（展示币种，KD8）。
 *
 * 惯例对齐 token-usage-dao.ts（better-sqlite3 同步 API + BaseDAO 语句缓存）。
 * 只建数据层：算钱的 BillingService 与 API 路由在后续票，经本 DAO 读配置。
 */

export type BillingCurrency = "USD" | "CNY"
export type BillingSettingKey = "usd_to_cny" | "display_currency"

/** billing_price_config 行 —— 单价语义 = 金额 / 1M tokens。 */
export interface BillingPriceRow {
  id: string
  vendor: string
  model_id: string
  input_unit_price: number
  output_unit_price: number
  cache_write_unit_price: number
  cache_read_unit_price: number
  currency: BillingCurrency
  created_at: string
  updated_at: string
}

/** createPrice 入参：id 缺省时自动生成，currency 缺省 CNY（spec US1 默认值）。 */
export interface BillingPriceInput {
  id?: string
  vendor: string
  model_id: string
  input_unit_price: number
  output_unit_price: number
  cache_write_unit_price: number
  cache_read_unit_price: number
  currency?: BillingCurrency
}

/** updatePrice 可改字段（id/created_at 不可动）。 */
export type BillingPricePatch = Partial<Omit<BillingPriceInput, "id">>

/**
 * 内置设置键的默认值兜底 —— 库里没有该键的行时 getSetting 返回这里。
 * 值与 spec US2 / KD7 / KD8 的默认口径一致：7.0、CNY。
 */
const SETTING_DEFAULTS: Record<BillingSettingKey, string> = {
  usd_to_cny: "7.0",
  display_currency: "CNY",
}

export class BillingDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── billing_price_config ─────────────────────────────────────────

  listPrices(): BillingPriceRow[] {
    return this.stmt("SELECT * FROM billing_price_config ORDER BY updated_at DESC").all() as BillingPriceRow[]
  }

  getPrice(id: string): BillingPriceRow | null {
    return (this.stmt("SELECT * FROM billing_price_config WHERE id = ?").get(id) as BillingPriceRow | undefined) ?? null
  }

  /** KD9 精确匹配：llm_calls.model ↔ model_id 直查，无模糊/无 vendor 参与。 */
  getPriceByModel(modelId: string): BillingPriceRow | null {
    return (this.stmt("SELECT * FROM billing_price_config WHERE model_id = ?").get(modelId) as BillingPriceRow | undefined) ?? null
  }

  /**
   * 插入一条价格。重复 model_id 由表上的 UNIQUE 约束抛 SqliteError
   * （API 层在后续票把它映射成 4xx；数据层不加 ON CONFLICT，保持"账可解释"）。
   */
  createPrice(input: BillingPriceInput): BillingPriceRow {
    const now = new Date().toISOString()
    const row: BillingPriceRow = {
      id: input.id ?? randomUUID(),
      vendor: input.vendor,
      model_id: input.model_id,
      input_unit_price: input.input_unit_price,
      output_unit_price: input.output_unit_price,
      cache_write_unit_price: input.cache_write_unit_price,
      cache_read_unit_price: input.cache_read_unit_price,
      currency: input.currency ?? "CNY",
      created_at: now,
      updated_at: now,
    }
    this.stmt(`
      INSERT INTO billing_price_config (
        id, vendor, model_id,
        input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price,
        currency, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.vendor, row.model_id,
      row.input_unit_price, row.output_unit_price, row.cache_write_unit_price, row.cache_read_unit_price,
      row.currency, row.created_at, row.updated_at,
    )
    return row
  }

  /** 改价即时生效于新调用；历史行不回算（KD3）由调用侧快照保证，这里只动配置表。 */
  updatePrice(id: string, patch: BillingPricePatch): BillingPriceRow | null {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const key of ["vendor", "model_id", "input_unit_price", "output_unit_price", "cache_write_unit_price", "cache_read_unit_price", "currency"] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`)
        vals.push(patch[key])
      }
    }
    vals.push(id)
    const res = this.stmt(`UPDATE billing_price_config SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
    return res.changes > 0 ? this.getPrice(id) : null
  }

  /** 删除价格行。返回 false = id 不存在（幂等语义交给 API 层裁量）。 */
  deletePrice(id: string): boolean {
    return this.stmt("DELETE FROM billing_price_config WHERE id = ?").run(id).changes > 0
  }

  // ── billing_setting ──────────────────────────────────────────────

  /** 读取设置；未设置过的内置键返回默认值（AC: settings 读写含默认值兜底）。 */
  getSetting(key: BillingSettingKey): string {
    const row = this.stmt("SELECT value FROM billing_setting WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value ?? SETTING_DEFAULTS[key]
  }

  getAllSettings(): Record<BillingSettingKey, string> {
    return {
      usd_to_cny: this.getSetting("usd_to_cny"),
      display_currency: this.getSetting("display_currency"),
    }
  }

  /** 手工汇率 1 USD = N CNY（KD7，即时生效）。 */
  getUsdToCny(): number {
    return Number(this.getSetting("usd_to_cny"))
  }

  getDisplayCurrency(): BillingCurrency {
    return this.getSetting("display_currency") as BillingCurrency
  }

  /** UPSERT —— 同键第二次 set 是覆盖，不产生双行。 */
  setSetting(key: BillingSettingKey, value: string): void {
    this.stmt(`
      INSERT INTO billing_setting (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  // ── llm_calls 流水读模型（票06 · GET /api/system/billing/calls）────────

  listCallModels(): string[] {
    return (this.stmt(
      "SELECT DISTINCT model FROM llm_calls WHERE model IS NOT NULL ORDER BY model",
    ).all() as { model: string }[]).map(r => r.model)
  }

  /**
   * 分页流水，timestamp 倒序（US5 筛选 = 模型精确 / 时间含界 / 定价状态 / 工作区 /
   * billing-coverage-2 票05: 来源 source_path）。只读 —— 明细行的四件套写入口在
   * token-usage-dao（票04）+ 共用落账 helper（票01），本方法不做 cost 语义。
   */
  listCalls(filters: BillingCallFilters, limit: number, offset: number): { rows: BillingCallRow[]; total: number } {
    const { where, params } = callFilterWhere(filters)
    const rows = this.stmt(`
      SELECT id, node_execution_id, execution_id, turn_index, call_index, model, timestamp,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             cost_usd, cost_native, cost_currency, price_status,
             workspace_id, workflow_ref, node_id, session_id, source_path
      FROM llm_calls
      ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as BillingCallRow[]
    const total = (this.stmt(`SELECT COUNT(*) AS cnt FROM llm_calls ${where}`).get(...params) as { cnt: number }).cnt
    return { rows, total }
  }

  /**
   * 各来源费用小计（票05 / KD26 —— **当前筛选条件下**的各来源合计，随 listCalls 同一 WHERE）。
   * 口径：count = 该来源全部行；priced_count = 其中 price_status='priced' 的行数；
   * cost_usd = priced 行 cost 求和（USD 归一值，KD5），unpriced/legacy 行**计入行数不计入费用**；
   * 全部未定价 → cost_usd = NULL（KD4 聚合不焊 0）。NULL 来源行（回填前老行）归 'unknown'。
   */
  sourceSubtotals(filters: BillingCallFilters): BillingSourceSubtotal[] {
    const { where, params } = callFilterWhere(filters)
    return this.stmt(`
      SELECT COALESCE(source_path, 'unknown') AS source,
             COUNT(*) AS count,
             SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) AS priced_count,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) AS cost_usd
      FROM llm_calls
      ${where}
      GROUP BY COALESCE(source_path, 'unknown')
      ORDER BY COALESCE(SUM(CASE WHEN price_status = 'priced' THEN cost_usd END), -1) DESC, source ASC
    `).all(...params) as BillingSourceSubtotal[]
  }

  // ── 报表聚合（billing-report-3 票02）──────────────────────────────────
  // 单一真相源 = llm_calls（KD20，不用 node_token_usages）；SQL 内 GROUP BY 完成（KD22）；
  // 数量类聚合计入 unpriced 行、费用类排除且全未定价 = NULL（KD21/KD4）；
  // 时间按 epoch ms 含界（本地日界换算在路由层，KD24）。

  /**
   * 费用/数量分布（breakdown）。group_by：
   *   - model：llm_calls.model，NULL 归 'unknown'
   *   - vendor：经 model→billing_price_config.vendor 关联（KD23）；无价/无厂商 = 'unknown'
   *   - source：COALESCE(source_path,'unknown')（口径同 sourceSubtotals）
   * 出参按费用降序（NULL 费用组垫底，惯例同 sourceSubtotals），费用仅计 priced 行（USD 基准）。
   */
  reportBreakdown(groupBy: BillingReportGroupBy, fromTs?: number, toTs?: number): BillingReportGroup[] {
    const keyExpr: Record<BillingReportGroupBy, string> = {
      model: "COALESCE(l.model, 'unknown')",
      vendor: "COALESCE(p.vendor, 'unknown')",
      source: "COALESCE(l.source_path, 'unknown')",
    }
    const join = groupBy === 'vendor'
      // KD9 全等匹配（BINARY 比较即大小写敏感）；同 model_id 表上 UNIQUE，至多一行 vendor
      ? 'LEFT JOIN billing_price_config p ON p.model_id = l.model'
      : ''
    const conditions: string[] = []
    const params: unknown[] = []
    if (fromTs !== undefined) { conditions.push('l.timestamp >= ?'); params.push(fromTs) }
    if (toTs !== undefined) { conditions.push('l.timestamp <= ?'); params.push(toTs) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const cost = 'SUM(CASE WHEN l.price_status = \'priced\' THEN l.cost_usd END)'
    const key = keyExpr[groupBy]
    return this.stmt(`
      SELECT ${key} AS key,
             ${cost} AS cost_usd,
             COUNT(*) AS calls
      FROM llm_calls l
      ${join}
      ${where}
      GROUP BY ${key}
      ORDER BY COALESCE(${cost}, -1) DESC, key ASC
    `).all(...params) as BillingReportGroup[]
  }

  /**
   * 费用排行 Top N（票02 / KD25：limit 上限校验在 API 层）。by：
   *   - workspace：GROUP BY workspace_id，name = workspaces.name，取不到显示 id
   *   - session：GROUP BY session_id，name 双表兜底 sessions.title → chat_sessions.title，
   *     取不到显示 id；NULL 归属归 'unknown' 组（口径同 breakdown 的 unknown 惯例）
   * 数量含 unpriced、费用仅 priced（全未定价组 = NULL 垫底，惯例同 sourceSubtotals）。
   */
  reportRanking(by: BillingReportRankBy, fromTs: number | undefined, toTs: number | undefined, limit: number): BillingReportRankRow[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (fromTs !== undefined) { conditions.push('l.timestamp >= ?'); params.push(fromTs) }
    if (toTs !== undefined) { conditions.push('l.timestamp <= ?'); params.push(toTs) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const cost = 'SUM(CASE WHEN l.price_status = \'priced\' THEN l.cost_usd END)'
    const idExpr = by === 'workspace'
      ? "COALESCE(l.workspace_id, 'unknown')"
      : "COALESCE(l.session_id, 'unknown')"
    const joins = by === 'workspace'
      ? 'LEFT JOIN workspaces w ON w.id = l.workspace_id'
      : 'LEFT JOIN sessions s ON s.id = l.session_id LEFT JOIN chat_sessions cs ON cs.id = l.session_id'
    // MAX() 仅为满足聚合格式 —— id 对名称表至多一行关联（主键），取值即该组名称
    const nameExpr = by === 'workspace'
      ? "COALESCE(MAX(w.name), COALESCE(l.workspace_id, 'unknown'))"
      : "COALESCE(MAX(s.title), MAX(cs.title), COALESCE(l.session_id, 'unknown'))"
    params.push(limit)
    return this.stmt(`
      SELECT ${idExpr} AS id,
             ${nameExpr} AS name,
             ${cost} AS cost_usd,
             COUNT(*) AS calls
      FROM llm_calls l
      ${joins}
      ${where}
      GROUP BY ${idExpr}
      ORDER BY COALESCE(${cost}, -1) DESC, id ASC
      LIMIT ?
    `).all(...params) as BillingReportRankRow[]
  }

  /**
   * 区间汇总（票01 · reportSummary；timestamp epoch ms 含界）。
   * 数量类含 unpriced、费用类仅 priced；空区间费用 = 0（AC2 全 0 结构），
   * 有行但全无 priced 费用 = NULL（KD4 不焊 0）。token SUM 对空集 COALESCE 0。
   */
  reportSummary(fromTs: number, toTs: number): BillingReportSummary {
    const row = this.stmt(`
      SELECT
        COUNT(*) AS total_calls,
        COALESCE(SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END), 0) AS priced_calls,
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) END AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM llm_calls
      WHERE timestamp >= ? AND timestamp <= ?
    `).get(fromTs, toTs) as Omit<BillingReportSummary, "unpriced_calls">
    return { ...row, unpriced_calls: row.total_calls - row.priced_calls }
  }

  /**
   * 按日趋势（票01 / KD24 本地日界：date(ts/1000,'unixepoch','localtime')，日界 = 本地 0 点）。
   * 只返回有调用的日 —— 无调用日补 0 由路由层按日历枚举（票面 AC"无调用日补 0"）。
   * cost_usd NULL = 当日有行但全无 priced（KD4）；当日费用仅计 priced 行（KD21）。
   */
  reportTrend(fromTs: number, toTs: number): BillingReportTrendDay[] {
    return this.stmt(`
      SELECT date(timestamp / 1000.0, 'unixepoch', 'localtime') AS day,
             COUNT(*) AS calls,
             SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) AS priced_calls,
             SUM(CASE WHEN price_status = 'priced' THEN cost_usd END) AS cost_usd
      FROM llm_calls
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(fromTs, toTs) as BillingReportTrendDay[]
  }
}

/** llm_calls 流水行（票06 API 契约 —— 展示币种换算在前端纯函数做，这里原样快照）。 */
export interface BillingCallRow {
  id: string
  node_execution_id: string
  execution_id: string
  turn_index: number
  call_index: number
  model: string | null
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number | null
  cost_native: number | null
  cost_currency: string | null
  price_status: string | null
  workspace_id: string | null
  workflow_ref: string | null
  node_id: string | null
  session_id: string | null
  /** billing-coverage-2 票05 (KD20): 来源维度。回填后全表非 NULL；老库快照可能为 null。 */
  source_path: string | null
}

/** 各来源小计行（票05 / KD26，口径见 sourceSubtotals 注释）。 */
export interface BillingSourceSubtotal {
  source: string
  count: number
  priced_count: number
  cost_usd: number | null
}

/** 报表分布维度（billing-report-3 票02 / spec API seam）。 */
export type BillingReportGroupBy = 'model' | 'vendor' | 'source'

/** 分布聚合行 —— share/展示币种换算在 API 层（换算规则唯一，见 KD22）。 */
export interface BillingReportGroup {
  key: string
  /** priced 行 USD 基准合计；全未定价 = NULL（KD4） */
  cost_usd: number | null
  /** 全部行数（含 unpriced，KD21） */
  calls: number
}

/** 报表排行维度（billing-report-3 票02 / US4）。 */
export type BillingReportRankBy = 'workspace' | 'session'

/** 排行聚合行 —— name 取不到时已在 SQL 兜底显示 id；展示换算在 API 层。 */
export interface BillingReportRankRow {
  id: string
  name: string
  cost_usd: number | null
  calls: number
}

/** 报表汇总行（票01；ratio/展示换算在路由层补齐）。 */
export interface BillingReportSummary {
  /** 空区间 = 0；有行但全无 priced = NULL（KD4）。 */
  total_cost_usd: number | null
  total_calls: number
  priced_calls: number
  /** price_status ≠ 'priced'（含回填前 NULL legacy 行，同不计费口径）。 */
  unpriced_calls: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
}

/** 报表趋势单日行（票01；仅含出现调用的日，补 0 在路由层）。 */
export interface BillingReportTrendDay {
  /** 本地日历日 YYYY-MM-DD（KD24） */
  day: string
  /** 全部行数（含 unpriced） */
  calls: number
  priced_calls: number
  /** priced 行合计；当日全无 priced = NULL（KD4） */
  cost_usd: number | null
}

export interface BillingCallFilters {
  model?: string
  priceStatus?: "priced" | "unpriced"
  workspaceId?: string
  /** billing-coverage-2 票05: source_path 枚举值；'unknown' 同时兜住回填前 NULL 老行（AC3）。 */
  sourcePath?: string
  /** billing-report-3 票04 联动下钻：session 精确（排行条目 → 明细） */
  sessionId?: string
  /** billing-report-3 票04 联动下钻：厂商（经 model→billing_price_config.vendor 关联，
   *  KD9 全等匹配语义同 breakdown；无价行 model 命不中价行 → 天然排除，unknown 组由前端降级不注入） */
  vendor?: string
  /** epoch ms，含界 */
  fromTs?: number
  toTs?: number
}

function callFilterWhere(f: BillingCallFilters): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (f.model !== undefined) { conditions.push("model = ?"); params.push(f.model) }
  if (f.priceStatus !== undefined) { conditions.push("price_status = ?"); params.push(f.priceStatus) }
  if (f.workspaceId !== undefined) { conditions.push("workspace_id = ?"); params.push(f.workspaceId) }
  if (f.sessionId !== undefined) { conditions.push("session_id = ?"); params.push(f.sessionId) }
  if (f.vendor !== undefined) {
    // 厂商经 model→价行关联（KD9 全等匹配语义同 breakdown）；无价/未命中行不在厂商下，
    // 故 vendor='unknown' 组下钻由前端降级为仅区间筛选，不注入此参数。
    conditions.push("model IN (SELECT model_id FROM billing_price_config WHERE vendor = ?)")
    params.push(f.vendor)
  }
  if (f.sourcePath !== undefined) {
    if (f.sourcePath === "unknown") {
      // 老行未回填 = NULL，展示与筛选口径同 COALESCE(source_path,'unknown')（小计同理）
      conditions.push("(source_path = 'unknown' OR source_path IS NULL)")
    } else {
      conditions.push("source_path = ?"); params.push(f.sourcePath)
    }
  }
  if (f.fromTs !== undefined) { conditions.push("timestamp >= ?"); params.push(f.fromTs) }
  if (f.toTs !== undefined) { conditions.push("timestamp <= ?"); params.push(f.toTs) }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params }
}
