// usage-admin-3 票02 —— /api/usage/llm-calls 分页浏览模式的取数面。
// 前端不新建 fetch 层：走 api-client 的 apiFetch/handleResponse 惯例（spec Seam 约定）。

import { getServerUrl } from "@/lib/server-config"
import { apiFetch, handleResponse } from "@/lib/api-client"

/** 与 server routes/usage.ts LlmCallView 同形状（wire snake→camel 已在出口做完）。 */
export interface UsageLlmCall {
  id: string
  nodeExecutionId: string | null
  executionId: string | null
  turnIndex: number
  callIndex: number
  messageId: string | null
  model: string | null
  stopReason: string | null
  timestamp: number
  durationMs: number
  ttftMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
  org: string | null
  workspaceId: string | null
  workflowRef: string | null
  nodeId: string | null
  sessionId: string | null
  instanceId: string | null
  source: string | null
  traceId: string | null
  spanId: string | null
}

export interface UsageFilters {
  source: string // "" = 全源（LLM_CALL_SOURCE 词表值）
  model: string
  session: string // session_id 精确
  org: string
  workspace?: string // workspace_id 精确（US1 筛选器补齐；可选以兼容既有调用点）
  window: "" | "7d" | "30d" | "90d" // "" = 全部；只带 from=now−N（时间倒序下 to 无意义）
}

export interface UsageLlmCallsPage {
  calls: UsageLlmCall[]
  total: number
  page: number
  pageSize: number
}

export const PAGE_SIZE = 50

const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 }

/** 纯函数：筛选器状态 + 页码 → query string（now 注入以便单测断言时间窗）。 */
export function buildLlmCallsQuery(f: UsageFilters, page: number, now = Date.now()): string {
  const p = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
  if (f.source) p.set("source", f.source)
  if (f.model) p.set("model", f.model)
  if (f.session) p.set("session_id", f.session)
  if (f.org) p.set("org", f.org)
  if (f.workspace) p.set("workspace_id", f.workspace)
  const days = WINDOW_DAYS[f.window]
  if (days) p.set("from", String(now - days * 86_400_000))
  return p.toString()
}

export async function fetchUsageLlmCalls(f: UsageFilters, page: number): Promise<UsageLlmCallsPage> {
  const res = await apiFetch(`${getServerUrl()}/api/usage/llm-calls?${buildLlmCallsQuery(f, page)}`)
  return handleResponse<UsageLlmCallsPage>(res)
}

// —— 票03：聚合视图（GET /api/usage/aggregate，票01 数据面）——

export type UsageAggregateDim = "day" | "source" | "model" | "clone"

/** 与 server UsageAggregateRowView 同形状（TopN+others 归并在出口做完）。 */
export interface UsageAggregateRow {
  key: string
  keyLabel: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number | null
  costComplete: boolean
  currency: string
  cacheHitRate: number | null
}

export interface UsageAggregateResponse {
  dim: UsageAggregateDim
  rows: UsageAggregateRow[]
}

/** 纯函数：dim + 02 筛选器复用面（org/时间窗）→ query；聚合不支持 source/model/session。 */
export function buildAggregateQuery(
  dim: UsageAggregateDim,
  f: { org: string; window: UsageFilters["window"]; workspace?: string },
  now = Date.now(),
): string {
  const p = new URLSearchParams({ dim })
  if (f.org) p.set("org", f.org)
  if (f.workspace) p.set("workspace_id", f.workspace)
  const days = WINDOW_DAYS[f.window]
  if (days) p.set("from", String(now - days * 86_400_000))
  return p.toString()
}

export async function fetchUsageAggregate(
  dim: UsageAggregateDim,
  f: { org: string; window: UsageFilters["window"]; workspace?: string },
): Promise<UsageAggregateResponse> {
  const res = await apiFetch(`${getServerUrl()}/api/usage/aggregate?${buildAggregateQuery(dim, f)}`)
  return handleResponse<UsageAggregateResponse>(res)
}

// —— 票04：trace 下钻（一次拉全组跨源调用，source=all 哨兵见 server）——

export function buildTraceQuery(traceId: string): string {
  return new URLSearchParams({ trace_id: traceId, source: "all", limit: "500" }).toString()
}

export async function fetchUsageTrace(traceId: string): Promise<UsageLlmCall[]> {
  const res = await apiFetch(`${getServerUrl()}/api/usage/llm-calls?${buildTraceQuery(traceId)}`)
  return (await handleResponse<{ calls: UsageLlmCall[] }>(res)).calls
}
