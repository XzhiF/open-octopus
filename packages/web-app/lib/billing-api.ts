import { apiFetch } from "@/lib/api-client"
import { getServerUrl } from "@/lib/server-config"

/**
 * 计费配置 API 客户端（billing-core-1 票05）。
 * 契约 = 票 03 已交付的 `/api/system/billing/*`（routes/system.ts）响应形状逐字段一致：
 *   GET  /prices    → { prices: BillingPrice[] }
 *   POST /prices    → 201 { price }；PUT /prices/:id → { price }；DELETE → { success, id }
 *   GET  /settings  → 平铺 { usd_to_cny, display_currency }；PUT → 200 回读生效值
 *   错误体 { error: { code, message, details? } }（DUPLICATE_MODEL_ID 409 等）
 */

export type BillingCurrency = "USD" | "CNY"

export interface BillingPrice {
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

export interface BillingSettings {
  usd_to_cny: string
  display_currency: BillingCurrency
}

/** POST body 形状（无 id/时间戳；票 03 createSchema 口径）。 */
export interface BillingPriceInput {
  vendor: string
  model_id: string
  input_unit_price: number
  output_unit_price: number
  cache_write_unit_price: number
  cache_read_unit_price: number
  currency: BillingCurrency
}

export class BillingApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message)
  }
}

const base = () => `${getServerUrl()}/api/system/billing`

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>))
  if (!res.ok) {
    const err = body.error as { code?: string; message?: string } | undefined
    throw new BillingApiError(err?.message ?? `HTTP ${res.status}`, err?.code, res.status)
  }
  return body as T
}

export async function listPrices(): Promise<BillingPrice[]> {
  const body = await parse<{ prices?: BillingPrice[] }>(await apiFetch(`${base()}/prices`))
  return body.prices ?? []
}

export async function createPrice(input: BillingPriceInput): Promise<BillingPrice> {
  const body = await parse<{ price: BillingPrice }>(await apiFetch(`${base()}/prices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
  return body.price
}

export async function updatePrice(id: string, input: BillingPriceInput): Promise<BillingPrice> {
  const body = await parse<{ price: BillingPrice }>(await apiFetch(`${base()}/prices/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
  return body.price
}

export async function deletePrice(id: string): Promise<void> {
  await parse<{ success: boolean }>(await apiFetch(`${base()}/prices/${encodeURIComponent(id)}`, { method: "DELETE" }))
}

export async function getSettings(): Promise<BillingSettings> {
  return parse<BillingSettings>(await apiFetch(`${base()}/settings`))
}

/** PUT 成功即返回服务端生效值 —— 调用方以响应回读展示（票 05 设置卡"保存后 toast 回读"）。 */
export async function updateSettings(input: BillingSettings): Promise<BillingSettings> {
  return parse<BillingSettings>(await apiFetch(`${base()}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
}

// ── 流水（票06 GET /billing/calls）──────────────────────────────────────────

/** llm_calls 流水行 —— 票 04 写入口落库的快照列原样透出。 */
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
  /** billing-coverage-2 票05 (KD20): 来源维度（workflow/interaction/harness/clone_chat/
   *  global_chat/session_compress/unknown）。老库快照可能缺失 → 展示按「未知」。 */
  source_path?: string | null
}

/** 各来源费用小计（票05/KD26 —— 当前筛选条件下；口径：priced 行求和，unpriced 计行不计费）。 */
export interface BillingSourceSubtotal {
  source: string
  count: number
  priced_count: number
  cost_usd: number | null
}

export interface BillingCallsQuery {
  model?: string
  price_status?: "priced" | "unpriced"
  workspace_id?: string
  source_path?: string
  /** billing-report-3 票04 联动下钻：session / 厂商筛选 */
  session_id?: string
  vendor?: string
  from?: number
  to?: number
  page?: number
  page_size?: number
}

export interface BillingCallsResponse {
  calls: BillingCallRow[]
  total: number
  page: number
  pageSize: number
  models: string[]
  source_subtotals: BillingSourceSubtotal[]
}

export async function listBillingCalls(query: BillingCallsQuery = {}): Promise<BillingCallsResponse> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v))
  }
  const qs = params.toString()
  const body = await parse<{
    calls?: BillingCallRow[]; total?: number; page?: number; pageSize?: number; models?: string[];
    source_subtotals?: BillingSourceSubtotal[]
  }>(await apiFetch(`${base()}/calls${qs ? `?${qs}` : ""}`))
  return {
    calls: body.calls ?? [], total: body.total ?? 0, page: body.page ?? 1, pageSize: body.pageSize ?? 50,
    models: body.models ?? [], source_subtotals: body.source_subtotals ?? [],
  }
}

// ── 报表聚合（billing-report-3 票01 API / 票03 消费）───────────────────────────
// 出参形状 = 票 01 已交付的 /api/system/billing/report/summary|trend 响应（routes/system.ts）：
//   currency_rate = USD→展示币种乘数（CNY=usd_to_cny，USD=1，与明细页同汇率 US6）；
//   cost_display/cost_usd 可 NULL = 全未定价（KD4 不焊 0）；trend 无调用日补 0；本地日界 KD24。

export interface BillingReportRange { from: string; to: string } // YYYY-MM-DD（本地日）

export interface BillingReportSummary {
  from: string
  to: string
  total_cost_usd: number | null
  total_cost_display: number | null
  total_calls: number
  tokens: { in: number; out: number; cache_w: number; cache_r: number }
  unpriced: { calls: number; ratio: number }
  currency_rate: number
  display_currency: BillingCurrency
}

export interface BillingReportTrendDay {
  date: string
  cost_usd: number | null
  cost_display: number | null
  calls: number
}

export interface BillingReportTrend {
  from: string
  to: string
  currency_rate: number
  display_currency: BillingCurrency
  days: BillingReportTrendDay[]
}

function reportQuery(range: BillingReportRange): string {
  return new URLSearchParams({ from: range.from, to: range.to }).toString()
}

export async function getReportSummary(range: BillingReportRange): Promise<BillingReportSummary> {
  return parse<BillingReportSummary>(await apiFetch(`${base()}/report/summary?${reportQuery(range)}`))
}

export async function getReportTrend(range: BillingReportRange): Promise<BillingReportTrend> {
  return parse<BillingReportTrend>(await apiFetch(`${base()}/report/trend?${reportQuery(range)}`))
}

// ── 报表分布/排行（billing-report-3 票02 API / 票04 消费）────────────────────────
// 出参形状 = 票 02 已交付的 /api/system/billing/report/breakdown|ranking 响应：
//   breakdown items 按费用降序、share 和 = 1（无费用基准全 0）；ranking items 已 Top N。
//   双币种字段 cost_usd / cost_display（可 NULL = 该组全未定价，KD4），换算服务端完成。

export type BillingReportGroupBy = "model" | "vendor" | "source"
export type BillingReportRankBy = "workspace" | "session"

export interface BillingReportBreakdownItem {
  key: string
  cost_usd: number | null
  cost_display: number | null
  calls: number
  share: number
}

export interface BillingReportBreakdown {
  items: BillingReportBreakdownItem[]
  group_by: BillingReportGroupBy
  display_currency: BillingCurrency
  usd_to_cny: number
}

export interface BillingReportRankItem {
  id: string
  name: string
  cost_usd: number | null
  cost_display: number | null
  calls: number
}

export interface BillingReportRanking {
  items: BillingReportRankItem[]
  by: BillingReportRankBy
  limit: number
  display_currency: BillingCurrency
  usd_to_cny: number
}

export async function getReportBreakdown(groupBy: BillingReportGroupBy, range: BillingReportRange): Promise<BillingReportBreakdown> {
  const body = await parse<Partial<BillingReportBreakdown>>(await apiFetch(`${base()}/report/breakdown?group_by=${groupBy}&${reportQuery(range)}`))
  return { items: body.items ?? [], group_by: body.group_by ?? groupBy, display_currency: body.display_currency ?? "CNY", usd_to_cny: body.usd_to_cny ?? 1 }
}

/** KD25：Top N 默认 10，N≤50。 */
export async function getReportRanking(by: BillingReportRankBy, range: BillingReportRange, limit = 10): Promise<BillingReportRanking> {
  const body = await parse<Partial<BillingReportRanking>>(await apiFetch(`${base()}/report/ranking?by=${by}&limit=${limit}&${reportQuery(range)}`))
  return { items: body.items ?? [], by: body.by ?? by, limit: body.limit ?? limit, display_currency: body.display_currency ?? "CNY", usd_to_cny: body.usd_to_cny ?? 1 }
}

/**
 * 报表条目点击 → 明细 Tab 筛选注入（票04 联动契约）。
 * from/to 为报表区间（YYYY-MM-DD，KD24 本地日）；未知归属（模型/厂商/归属 id = 'unknown'）
 * 降级为仅区间筛选 —— 明细端点无对应可筛值。
 */
export interface BillingDrillDown {
  model?: string
  vendor?: string
  sourcePath?: string
  workspaceId?: string
  sessionId?: string
  from: string
  to: string
}
