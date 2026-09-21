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
