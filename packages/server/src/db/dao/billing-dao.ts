/**
 * BillingDAO — 计费数据层（billing NEW-r2：快照账 → 规则账）。
 * P1 B4：better-sqlite3 → postgres.js（BasePgDAO）。
 *
 * 两张表：
 *   - billing_price_config：价格**规则表**。每模型至多一条兜底价（valid_from/valid_to
 *     双 NULL，全时段生效 —— 晚配价立刻回算全部历史）；时间段价至少一端有界、
 *     半开区间 [from, to)（本地日零点，与 KD24 同一套日历）、同模型互不重叠。
 *     model_id = 规范名（normalizeModelId 双端归一的产物）。
 *   - billing_setting：usd_to_cny 手工汇率（KD7）+ display_currency（KD8）。
 *
 * 一切费用查询的算价 SQL 只来自 ../price-sql（全库唯一实现，Q7）——本 DAO 不出现
 * 第二份公式；TS 侧也不逐行算钱（报表必须 SQL 内聚合，KD22 保留）。
 *
 * B4 方言/契约注记：
 *   - valid_from/valid_to 与 llm_calls.timestamp 是 PG bigint（驱动侧 string）→
 *     出口 num()/numOrNull() 归一旧 number 契约；created_at/updated_at 为
 *     timestamptz(Date) → iso() 归一旧 ISO 文本。
 *   - COUNT → int8 string → num()；SUM(cost_usd) → float8（同 SQLite REAL 族）。
 *   - reportTrend 的 `date(ts,'unixepoch','localtime')` → 会话时区版
 *     `to_timestamp(...) AT TIME ZONE current_setting('TimeZone')` ——
 *     SQLite 'localtime' = 进程时区，PG 走连接会话时区（池未覆写 = 服务端默认），
 *     日界语义在混合期按引擎本地口径各自成立（B6 统一裁决日历源）。
 *   - ORDER BY DESC 的可空列补 NULLS LAST 对齐 SQLite（NULL 最小 → DESC 殿后）。
 */
import { randomUUID } from "crypto"
import { normalizeModelId } from "@octopus/shared"
import { BasePgDAO, type PgSql } from "./base-pg"
import { pricedCallsSql, pricePreviewSql, priceStatusExpr, PRICED_AGG } from "../price-sql"
import { iso, num, numOrNull } from "./pg-mappers"

export type BillingCurrency = "USD" | "CNY"
export type BillingSettingKey = "usd_to_cny" | "display_currency"

/** 价格窗口校验错误的判别码（API 层映射 400）。 */
export type BillingPriceErrorCode =
  | "PRICE_WINDOW_ORDER"       // from >= to（空区间/倒序）
  | "PRICE_WINDOW_OVERLAP"     // 与同模型既有时间段行交叠
  | "PRICE_CATCHALL_DUPLICATE" // 同模型已有第二条兜底价
  | "PRICE_MODEL_INVALID"      // model_id 归一化后为空

export class BillingPriceValidationError extends Error {
  constructor(public readonly code: BillingPriceErrorCode, message: string) {
    super(message)
    this.name = "BillingPriceValidationError"
  }
}

/** 价格窗口行（epoch ms bigint 的 PG 原始形态）。 */
interface BillingPricePgRow {
  id: string
  vendor: string
  model_id: string
  input_unit_price: number
  output_unit_price: number
  cache_write_unit_price: number
  cache_read_unit_price: number
  currency: BillingCurrency
  valid_from: string | number | null
  valid_to: string | number | null
  created_at: Date | string
  updated_at: Date | string
}

/** billing_price_config 行 —— 单价语义 = 金额 / 1M tokens；窗口 NULL 界 = ±∞。 */
export interface BillingPriceRow {
  id: string
  vendor: string
  model_id: string
  input_unit_price: number
  output_unit_price: number
  cache_write_unit_price: number
  cache_read_unit_price: number
  currency: BillingCurrency
  valid_from: number | null
  valid_to: number | null
  created_at: string
  updated_at: string
}

function fromPrice(r: BillingPricePgRow): BillingPriceRow {
  return {
    id: r.id,
    vendor: r.vendor,
    model_id: r.model_id,
    input_unit_price: r.input_unit_price,
    output_unit_price: r.output_unit_price,
    cache_write_unit_price: r.cache_write_unit_price,
    cache_read_unit_price: r.cache_read_unit_price,
    currency: r.currency,
    valid_from: numOrNull(r.valid_from),
    valid_to: numOrNull(r.valid_to),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

/** createPrice 入参：id 缺省自动生成；currency 缺省 CNY；窗口缺省 = 兜底价（双 NULL）。 */
export interface BillingPriceInput {
  id?: string
  vendor: string
  model_id: string
  input_unit_price: number
  output_unit_price: number
  cache_write_unit_price: number
  cache_read_unit_price: number
  currency?: BillingCurrency
  valid_from?: number | null
  valid_to?: number | null
}

/** updatePrice 可改字段（id/created_at 不可动）。窗口字段传 null = 拆掉该侧边界。 */
export type BillingPricePatch = Partial<Omit<BillingPriceInput, "id">>

/** 内置设置键的默认值兜底。 */
const SETTING_DEFAULTS: Record<BillingSettingKey, string> = {
  usd_to_cny: "7.0",
  display_currency: "CNY",
}

/** 两窗口 [a1,a2) × [b1,b2) 是否交叠（NULL = ±∞；贴边 from==to 不算重叠）。 */
function windowsOverlap(a1: number | null, a2: number | null, b1: number | null, b2: number | null): boolean {
  const aBeforeB = a2 !== null && b1 !== null && a2 <= b1
  const bBeforeA = b2 !== null && a1 !== null && b2 <= a1
  return !(aBeforeB || bBeforeA)
}

const isCatchall = (from: number | null | undefined, to: number | null | undefined): boolean =>
  (from ?? null) === null && (to ?? null) === null

export class BillingDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── billing_price_config（规则表 CRUD，写入侧 = SQL 命中去重之前的第一道闸）──

  async listPrices(): Promise<BillingPriceRow[]> {
    const rows = await this.q<BillingPricePgRow>(`
      SELECT * FROM billing_price_config
      ORDER BY model_id ASC,
               (valid_from IS NULL AND valid_to IS NULL) DESC,
               COALESCE(valid_from, -1) ASC, id ASC
    `)
    return rows.map(fromPrice)
  }

  async getPrice(id: string): Promise<BillingPriceRow | null> {
    const row = await this.q1<BillingPricePgRow>("SELECT * FROM billing_price_config WHERE id = ?", [id])
    return row ? fromPrice(row) : null
  }

  /** 时刻 ts 的命中价行（窗口优先、多命中取 valid_from 最大）—— 与 price-sql 同序。 */
  async getPriceAtModel(modelId: string, ts: number): Promise<BillingPriceRow | null> {
    const row = await this.q1<BillingPricePgRow>(`
      SELECT * FROM billing_price_config
      WHERE model_id = ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY (valid_from IS NULL AND valid_to IS NULL) ASC,
               COALESCE(valid_from, -1) DESC, id ASC
      LIMIT 1
    `, [modelId, ts, ts])
    return row ? fromPrice(row) : null
  }

  /**
   * 新增价格行。model_id 保存前归一化（双端规范名，Q9）；窗口校验：
   * 空区间/倒序 400、同模型第二条兜底价拒绝、与既有时间段行交叠拒绝。
   */
  async createPrice(input: BillingPriceInput): Promise<BillingPriceRow> {
    const modelId = normalizeModelId(input.model_id)
    if (!modelId) throw new BillingPriceValidationError("PRICE_MODEL_INVALID", `model_id 无效: ${input.model_id}`)
    const from = input.valid_from ?? null
    const to = input.valid_to ?? null
    await this.validateWindow(modelId, from, to, null)
    const now = new Date().toISOString()
    const row: BillingPriceRow = {
      id: input.id ?? randomUUID(),
      vendor: input.vendor,
      model_id: modelId,
      input_unit_price: input.input_unit_price,
      output_unit_price: input.output_unit_price,
      cache_write_unit_price: input.cache_write_unit_price,
      cache_read_unit_price: input.cache_read_unit_price,
      currency: input.currency ?? "CNY",
      valid_from: from,
      valid_to: to,
      created_at: now,
      updated_at: now,
    }
    await this.exec(`
      INSERT INTO billing_price_config (
        id, vendor, model_id,
        input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price,
        currency, valid_from, valid_to, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.vendor, row.model_id,
      row.input_unit_price, row.output_unit_price, row.cache_write_unit_price, row.cache_read_unit_price,
      row.currency, row.valid_from, row.valid_to, row.created_at, row.updated_at,
    ])
    return row
  }

  /**
   * 就地改价（Q6-A：规则表无审计）。改后按最终窗口重新校验（排除自身）。
   */
  async updatePrice(id: string, patch: BillingPricePatch): Promise<BillingPriceRow | null> {
    const existing = await this.getPrice(id)
    if (!existing) return null
    const modelId = patch.model_id !== undefined ? (normalizeModelId(patch.model_id) ?? "") : existing.model_id
    if (!modelId) throw new BillingPriceValidationError("PRICE_MODEL_INVALID", `model_id 无效: ${patch.model_id}`)
    const from = patch.valid_from !== undefined ? patch.valid_from : existing.valid_from
    const to = patch.valid_to !== undefined ? patch.valid_to : existing.valid_to
    await this.validateWindow(modelId, from, to, id)

    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    const assign = <K extends keyof BillingPricePatch>(key: K, col: string) => {
      if (patch[key] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[key]) }
    }
    assign("vendor", "vendor"); assign("input_unit_price", "input_unit_price")
    assign("output_unit_price", "output_unit_price"); assign("cache_write_unit_price", "cache_write_unit_price")
    assign("cache_read_unit_price", "cache_read_unit_price"); assign("currency", "currency")
    if (patch.model_id !== undefined) { sets.push("model_id = ?"); vals.push(modelId) }
    if (patch.valid_from !== undefined) { sets.push("valid_from = ?"); vals.push(patch.valid_from) }
    if (patch.valid_to !== undefined) { sets.push("valid_to = ?"); vals.push(patch.valid_to) }
    vals.push(id)
    await this.exec(`UPDATE billing_price_config SET ${sets.join(", ")} WHERE id = ?`, vals)
    return this.getPrice(id)
  }

  async deletePrice(id: string): Promise<boolean> {
    const r = await this.exec("DELETE FROM billing_price_config WHERE id = ?", [id])
    return r.changes > 0
  }

  /**
   * 列表页去重后的规范模型名 —— 配价下拉的真相源 = 账本上出现过的名字（Q8，
   * 落账前已归一，所见即所配）。
   */
  async listCallModels(): Promise<string[]> {
    return (await this.q<{ model: string }>(
      "SELECT DISTINCT model FROM llm_calls WHERE model IS NOT NULL ORDER BY model",
    )).map(r => r.model)
  }

  // ── 写入侧窗口校验 ───────────────────────────────────────────────

  private async validateWindow(modelId: string, from: number | null, to: number | null, excludeId: string | null): Promise<void> {
    if (from !== null && to !== null && from >= to) {
      throw new BillingPriceValidationError("PRICE_WINDOW_ORDER", `时间窗口无效: valid_from(${from}) 必须早于 valid_to(${to})（贴边需 from < to）`)
    }
    const rows = (excludeId !== null
      ? await this.q<{ id: string; valid_from: string | number | null; valid_to: string | number | null }>("SELECT id, valid_from, valid_to FROM billing_price_config WHERE model_id = ? AND id != ?", [modelId, excludeId])
      : await this.q<{ id: string; valid_from: string | number | null; valid_to: string | number | null }>("SELECT id, valid_from, valid_to FROM billing_price_config WHERE model_id = ?", [modelId]))
    for (const r of rows) {
      const rCatchall = isCatchall(numOrNull(r.valid_from), numOrNull(r.valid_to))
      if (isCatchall(from, to)) {
        if (rCatchall) {
          throw new BillingPriceValidationError("PRICE_CATCHALL_DUPLICATE", `模型 ${modelId} 已存在兜底价(${r.id})，每模型至多一条`)
        }
        continue // 兜底价与任何窗口行天然共存（窗口优先命中）
      }
      if (rCatchall) continue // 新窗口行 vs 既有兜底价：共存
      if (windowsOverlap(from, to, numOrNull(r.valid_from), numOrNull(r.valid_to))) {
        throw new BillingPriceValidationError("PRICE_WINDOW_OVERLAP", `时间窗口与模型 ${modelId} 的既有价格行(${r.id}) 重叠`)
      }
    }
  }

  // ── billing_setting ──────────────────────────────────────────────

  async getSetting(key: BillingSettingKey): Promise<string> {
    const row = await this.q1<{ value: string }>("SELECT value FROM billing_setting WHERE key = ?", [key])
    return row?.value ?? SETTING_DEFAULTS[key]
  }

  async getAllSettings(): Promise<Record<BillingSettingKey, string>> {
    return {
      usd_to_cny: await this.getSetting("usd_to_cny"),
      display_currency: await this.getSetting("display_currency"),
    }
  }

  /** 手工汇率 1 USD = N CNY（KD7）。规则账语义：改汇率 → 全局折价重算。 */
  async getUsdToCny(): Promise<number> {
    return Number(await this.getSetting("usd_to_cny"))
  }

  async getDisplayCurrency(): Promise<BillingCurrency> {
    return await this.getSetting("display_currency") as BillingCurrency
  }

  async setSetting(key: BillingSettingKey, value: string): Promise<void> {
    await this.exec(`
      INSERT INTO billing_setting (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, value])
  }

  // ── 试算器（配价页的解释器：模型+时刻+token → 命中行与钱） ─────────
  // 与账本查询共用同一片段（pricePreviewSql），永不存在第二份公式。

  async previewCost(model: string | null, ts: number, usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): Promise<BillingPricePreview> {
    const row = await this.q1<Omit<BillingPricePreview, "price_status"> & { timestamp: string | number }>(pricePreviewSql(), [
      model ? normalizeModelId(model) : null, ts,
      usage.inputTokens, usage.outputTokens,
      usage.cacheCreationTokens, usage.cacheReadTokens,
    ])
    if (!row) throw new Error("[billing] pricePreviewSql 必须恰好返回一行")
    const cost_usd = numOrNull(row.cost_usd)
    return {
      model: row.model,
      timestamp: num(row.timestamp),
      cost_usd,
      cost_native: numOrNull(row.cost_native),
      cost_currency: row.cost_currency,
      vendor: row.vendor,
      price_id: row.price_id,
      price_status: cost_usd !== null ? "priced" : "unpriced",
    }
  }

  // ── llm_calls 流水读模型（钱 = 查询时派生） ────────────────────────

  /**
   * 分页流水，timestamp 倒序。筛选口径不变：模型精确 / 时间含界 / 定价状态(派生) /
   * 工作区 / session / 厂商(命中价行) / 来源。price_status 与 vendor 是派生列，
   * 在内层子查询里算好后外层筛。
   */
  async listCalls(filters: BillingCallFilters, limit: number, offset: number): Promise<{ rows: BillingCallRow[]; total: number }> {
    const { inner, innerParams, outerConds, outerParams } = buildCallFilter(filters)
    const outer = outerConds.length > 0 ? `WHERE ${outerConds.join(" AND ")}` : ""
    const rows = await this.q<Omit<BillingCallRow, "turn_index" | "call_index" | "timestamp" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "cost_usd"> & {
      turn_index: number; call_index: number
      timestamp: string | number
      input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number
      cost_usd: number | null
    }>(`
      SELECT id, node_execution_id, execution_id, turn_index, call_index, model, timestamp,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             cost_usd, ${priceStatusExpr("q")} AS price_status,
             workspace_id, workflow_ref, node_id, session_id, source_path
      FROM (${inner}) q
      ${outer}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...innerParams, ...outerParams, limit, offset])
    const totalRow = await this.q1<{ cnt: string | number }>(
      `SELECT COUNT(*) AS cnt FROM (${inner}) q ${outer}`,
      [...innerParams, ...outerParams],
    )
    return {
      rows: rows.map(r => ({ ...r, timestamp: num(r.timestamp), cost_usd: numOrNull(r.cost_usd) })),
      total: num(totalRow?.cnt),
    }
  }

  /**
   * 各来源费用小计（当前筛选口径下）。priced_count = 命中价行数；
   * cost_usd = SUM(派生费用)，全未定价组 → NULL 不焊 0（KD4 聚合语义保留）。
   */
  async sourceSubtotals(filters: BillingCallFilters): Promise<BillingSourceSubtotal[]> {
    const { inner, innerParams, outerConds, outerParams } = buildCallFilter(filters)
    const outer = outerConds.length > 0 ? `WHERE ${outerConds.join(" AND ")}` : ""
    const rows = await this.q<{ source: string; count: string | number; priced_count: string | number; cost_usd: number | null }>(`
      SELECT COALESCE(q.source_path, 'unknown') AS source,
             COUNT(*) AS count,
             ${PRICED_AGG.countPriced()} AS priced_count,
             ${PRICED_AGG.sumCost()} AS cost_usd
      FROM (${inner}) q
      ${outer}
      GROUP BY COALESCE(q.source_path, 'unknown')
      ORDER BY COALESCE(${PRICED_AGG.sumCost()}, -1) DESC, source ASC
    `, [...innerParams, ...outerParams])
    return rows.map(r => ({ source: r.source, count: num(r.count), priced_count: num(r.priced_count), cost_usd: numOrNull(r.cost_usd) }))
  }

  // ── 报表聚合（单一真相源 llm_calls + SQL 内 GROUP BY，KD20/KD22 保留；
  //    钱自 NEW-r2 起为查询时按窗口匹配，KD4「全未定价=NULL」语义不变） ──

  /**
   * 区间汇总。数量类含 unpriced、费用类仅命中价行；空区间费用 = 0，
   * 有行但全无价 = NULL（不焊 0）。
   */
  async reportSummary(fromTs: number, toTs: number): Promise<BillingReportSummary> {
    const { sql, params } = pricedCallsSql(["l.timestamp >= ?", "l.timestamp <= ?"], [fromTs, toTs])
    const row = await this.q1<Omit<BillingReportSummary, "unpriced_calls" | "total_calls" | "priced_calls" | "input_tokens" | "output_tokens" | "cache_creation_tokens" | "cache_read_tokens"> & {
      total_calls: string | number; priced_calls: string | number
      total_cost_usd: number | null
      input_tokens: string | number; output_tokens: string | number
      cache_creation_tokens: string | number; cache_read_tokens: string | number
    }>(`
      SELECT
        COUNT(*) AS total_calls,
        ${PRICED_AGG.countPriced()} AS priced_calls,
        CASE WHEN COUNT(*) = 0 THEN 0 ELSE ${PRICED_AGG.sumCost()} END AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM (${sql}) q
    `, params)
    const total_calls = num(row?.total_calls)
    const priced_calls = num(row?.priced_calls)
    return {
      total_calls,
      priced_calls,
      unpriced_calls: total_calls - priced_calls,
      total_cost_usd: numOrNull(row?.total_cost_usd),
      input_tokens: num(row?.input_tokens),
      output_tokens: num(row?.output_tokens),
      cache_creation_tokens: num(row?.cache_creation_tokens),
      cache_read_tokens: num(row?.cache_read_tokens),
    }
  }

  /** 按日趋势（KD24 本地日界）。当日全无价 → cost_usd NULL（不焊 0）。 */
  async reportTrend(fromTs: number, toTs: number): Promise<BillingReportTrendDay[]> {
    const { sql, params } = pricedCallsSql(["l.timestamp >= ?", "l.timestamp <= ?"], [fromTs, toTs])
    const rows = await this.q<{ day: string; calls: string | number; priced_calls: string | number; cost_usd: number | null }>(`
      SELECT to_char(to_timestamp(q.timestamp / 1000.0) AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD') AS day,
             COUNT(*) AS calls,
             ${PRICED_AGG.countPriced()} AS priced_calls,
             ${PRICED_AGG.sumCost()} AS cost_usd
      FROM (${sql}) q
      GROUP BY day
      ORDER BY day ASC
    `, params)
    return rows.map(r => ({ day: r.day, calls: num(r.calls), priced_calls: num(r.priced_calls), cost_usd: numOrNull(r.cost_usd) }))
  }

  /**
   * 费用/数量分布。vendor 键 = 账本行**命中价行**的厂商（NEW-r2：不再是"该模型
   * 有条价就行"，而是这笔账实际用哪条价算的 —— 解释力更强）。
   */
  async reportBreakdown(groupBy: BillingReportGroupBy, fromTs?: number, toTs?: number): Promise<BillingReportGroup[]> {
    const rawWhere: string[] = []
    const params: unknown[] = []
    if (fromTs !== undefined) { rawWhere.push("l.timestamp >= ?"); params.push(fromTs) }
    if (toTs !== undefined) { rawWhere.push("l.timestamp <= ?"); params.push(toTs) }
    const { sql } = pricedCallsSql(rawWhere, params)
    const key: Record<BillingReportGroupBy, string> = {
      model: "COALESCE(q.model, 'unknown')",
      vendor: "COALESCE(q.vendor, 'unknown')",
      source: "COALESCE(q.source_path, 'unknown')",
    }
    const k = key[groupBy]
    const rows = await this.q<{ key: string; cost_usd: number | null; calls: string | number }>(`
      SELECT ${k} AS key,
             ${PRICED_AGG.sumCost()} AS cost_usd,
             COUNT(*) AS calls
      FROM (${sql}) q
      GROUP BY ${k}
      ORDER BY COALESCE(${PRICED_AGG.sumCost()}, -1) DESC, key ASC
    `, params)
    return rows.map(r => ({ key: r.key, cost_usd: numOrNull(r.cost_usd), calls: num(r.calls) }))
  }

  /** 费用排行 Top N。by=workspace/session；归属 NULL 归 'unknown' 组。 */
  async reportRanking(by: BillingReportRankBy, fromTs: number | undefined, toTs: number | undefined, limit: number): Promise<BillingReportRankRow[]> {
    const rawWhere: string[] = []
    const params: unknown[] = []
    if (fromTs !== undefined) { rawWhere.push("l.timestamp >= ?"); params.push(fromTs) }
    if (toTs !== undefined) { rawWhere.push("l.timestamp <= ?"); params.push(toTs) }
    const { sql } = pricedCallsSql(rawWhere, params)
    const idExpr = by === 'workspace'
      ? "COALESCE(q.workspace_id, 'unknown')"
      : "COALESCE(q.session_id, 'unknown')"
    const joins = by === 'workspace'
      ? 'LEFT JOIN workspaces w ON w.id = q.workspace_id'
      : 'LEFT JOIN sessions s ON s.id = q.session_id LEFT JOIN chat_sessions cs ON cs.id = q.session_id'
    const nameExpr = by === 'workspace'
      ? "COALESCE(MAX(w.name), COALESCE(q.workspace_id, 'unknown'))"
      : "COALESCE(MAX(s.title), MAX(cs.title), COALESCE(q.session_id, 'unknown'))"
    params.push(limit)
    const rows = await this.q<{ id: string; name: string; cost_usd: number | null; calls: string | number }>(`
      SELECT ${idExpr} AS id,
             ${nameExpr} AS name,
             ${PRICED_AGG.sumCost()} AS cost_usd,
             COUNT(*) AS calls
      FROM (${sql}) q
      ${joins}
      GROUP BY ${idExpr}
      ORDER BY COALESCE(${PRICED_AGG.sumCost()}, -1) DESC, id ASC
      LIMIT ?
    `, params)
    return rows.map(r => ({ id: r.id, name: r.name, cost_usd: numOrNull(r.cost_usd), calls: num(r.calls) }))
  }
}

/** listCalls / sourceSubtotals 共用的筛选构造。 */
function buildCallFilter(f: BillingCallFilters): {
  inner: string; innerParams: unknown[]; outerConds: string[]; outerParams: unknown[]
} {
  const raw: string[] = []
  const innerParams: unknown[] = []
  const outerConds: string[] = []
  const outerParams: unknown[] = []
  if (f.model !== undefined) { raw.push("l.model = ?"); innerParams.push(normalizeModelId(f.model) ?? f.model) }
  if (f.workspaceId !== undefined) { raw.push("l.workspace_id = ?"); innerParams.push(f.workspaceId) }
  if (f.sessionId !== undefined) { raw.push("l.session_id = ?"); innerParams.push(f.sessionId) }
  if (f.sourcePath !== undefined) {
    if (f.sourcePath === "unknown") {
      raw.push("(l.source_path = 'unknown' OR l.source_path IS NULL)")
    } else { raw.push("l.source_path = ?"); innerParams.push(f.sourcePath) }
  }
  if (f.fromTs !== undefined) { raw.push("l.timestamp >= ?"); innerParams.push(f.fromTs) }
  if (f.toTs !== undefined) { raw.push("l.timestamp <= ?"); innerParams.push(f.toTs) }
  // 派生列筛选在外层（内层子查询已算好）
  if (f.priceStatus !== undefined) { outerConds.push(`${priceStatusExpr("q")} = ?`); outerParams.push(f.priceStatus) }
  if (f.vendor !== undefined) { outerConds.push("q.vendor = ?"); outerParams.push(f.vendor) }
  const { sql: inner, params } = pricedCallsSql(raw, innerParams)
  return { inner, innerParams: params, outerConds, outerParams }
}

/** llm_calls 流水行（票06 API 契约延续；cost_usd/price_status 自 NEW-r2 起为查询时派生，
 *  原币双列 cost_native/cost_currency 随快照列一并从契约移除）。 */
export interface BillingCallRow {
  id: string
  node_execution_id: string | null
  execution_id: string | null
  turn_index: number
  call_index: number
  model: string | null
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  /** 派生：查询时按窗口命中的价算出的 USD 基准费用；unpriced = NULL。 */
  cost_usd: number | null
  /** 派生：priced | unpriced（= cost_usd 是否命中价行）。 */
  price_status: string | null
  workspace_id: string | null
  workflow_ref: string | null
  node_id: string | null
  session_id: string | null
  source_path: string | null
}

/** 试算结果（配价页解释器）。 */
export interface BillingPricePreview {
  model: string | null
  timestamp: number
  cost_usd: number | null
  cost_native: number | null
  cost_currency: string | null
  vendor: string | null
  price_id: string | null
  price_status: "priced" | "unpriced"
}

export interface BillingSourceSubtotal {
  source: string
  count: number
  priced_count: number
  cost_usd: number | null
}

export type BillingReportGroupBy = 'model' | 'vendor' | 'source'

export interface BillingReportGroup {
  key: string
  cost_usd: number | null
  calls: number
}

export type BillingReportRankBy = 'workspace' | 'session'

export interface BillingReportRankRow {
  id: string
  name: string
  cost_usd: number | null
  calls: number
}

export interface BillingReportSummary {
  total_cost_usd: number | null
  total_calls: number
  priced_calls: number
  unpriced_calls: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
}

export interface BillingReportTrendDay {
  day: string
  calls: number
  priced_calls: number
  cost_usd: number | null
}

export interface BillingCallFilters {
  model?: string
  priceStatus?: "priced" | "unpriced"
  workspaceId?: string
  sourcePath?: string
  sessionId?: string
  vendor?: string
  /** epoch ms，含界 */
  fromTs?: number
  toTs?: number
}
