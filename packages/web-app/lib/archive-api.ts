import { getServerUrl } from "./server-config"

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}

// ============ Archive Types ============

export interface ArchiveStats {
  total_executions: number
  total_cost_usd: number
  success_rate: number
  today_cost_usd: number
  week_cost_usd: number
  month_cost_usd: number
  top_workflows: {
    workflow_ref: string
    workflow_name: string
    execution_count: number
    success_rate: number
    total_cost_usd: number
  }[]
}

export interface ArchiveExecutionItem {
  id: string
  workflow_ref: string
  workflow_name: string
  status: "completed" | "failed" | "cancelled"
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
  workspace_id: string | null
  parent_execution_id: string | null
  chain_position: number | null
  created_at: string
}

export interface ArchiveExecutionDetail extends ArchiveExecutionItem {
  node_summary: {
    node_id: string
    type: string
    status: string
    duration_ms: number | null
    exit_code: number | null
  }[]
  failed_nodes: string[] | null
  error_message: string | null
  model_breakdown: Record<string, {
    input_tokens: number
    output_tokens: number
    cost_usd: number
  }> | null
  vars_snapshot: Record<string, unknown>
  lessons_learned: string | null
  experiences: {
    id: string
    type: "bug" | "pattern" | "cost" | "failure"
    title: string
    content: string
    status: string
    created_at: string
  }[]
  workspace_archive_id: string | null
}

export interface CostTrendPoint {
  date: string
  total_cost_usd: number
  execution_count: number
}

export interface CostTrendSummary {
  total_cost_usd: number
  avg_daily_cost_usd: number
  trend: "up" | "down" | "stable"
}

export interface WorkflowStat {
  workflow_ref: string
  workflow_name: string
  execution_count: number
  success_count: number
  failure_count: number
  success_rate: number
  total_cost_usd: number
  avg_cost_usd: number
  avg_duration_ms: number
}

export interface ExperienceLesson {
  id: string
  type: "bug" | "pattern" | "cost" | "failure"
  title: string
  content: string
  status: string
  project: string | null
  package: string | null
  file_pattern: string | null
  workflow_name: string | null
  relevance_score: number
  use_count: number
  created_at: string
}

export interface LeaderboardEntry {
  rank: number
  workflow_ref: string
  workflow_name: string
  value: number
  execution_count: number
}

// ============ Archive API Functions ============

export async function fetchArchiveStats(): Promise<ArchiveStats> {
  const res = await apiFetch(`${getServerUrl()}/api/archive/stats`)
  return handleResponse(res)
}

export async function fetchArchiveExecutions(params: {
  page?: number
  limit?: number
  workflow_ref?: string
  status?: "completed" | "failed" | "cancelled"
  workspace_id?: string
  date_from?: string
  date_to?: string
  sort?: "created_at" | "total_cost_usd" | "duration_ms"
  order?: "asc" | "desc"
} = {}): Promise<{ items: ArchiveExecutionItem[], total: number, page: number, limit: number }> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set("page", String(params.page))
  if (params.limit) searchParams.set("limit", String(params.limit))
  if (params.workflow_ref) searchParams.set("workflow_ref", params.workflow_ref)
  if (params.status) searchParams.set("status", params.status)
  if (params.workspace_id) searchParams.set("workspace_id", params.workspace_id)
  if (params.date_from) searchParams.set("date_from", params.date_from)
  if (params.date_to) searchParams.set("date_to", params.date_to)
  if (params.sort) searchParams.set("sort", params.sort)
  if (params.order) searchParams.set("order", params.order)
  const qs = searchParams.toString()
  const res = await apiFetch(`${getServerUrl()}/api/archive/executions${qs ? `?${qs}` : ""}`)
  return handleResponse(res)
}

export async function fetchArchiveExecution(id: string): Promise<ArchiveExecutionDetail> {
  const res = await apiFetch(`${getServerUrl()}/api/archive/executions/${id}`)
  return handleResponse(res)
}

export async function fetchCostTrends(days: number = 30, workspaceId?: string): Promise<{
  trends: CostTrendPoint[]
  summary: CostTrendSummary
}> {
  const searchParams = new URLSearchParams()
  searchParams.set("days", String(days))
  if (workspaceId) searchParams.set("workspace_id", workspaceId)
  const res = await apiFetch(`${getServerUrl()}/api/archive/cost-trends?${searchParams.toString()}`)
  return handleResponse(res)
}

export async function fetchWorkflowStats(params?: {
  days?: number
  sort?: "execution_count" | "success_rate" | "total_cost_usd"
  order?: "asc" | "desc"
  limit?: number
}): Promise<{ items: WorkflowStat[] }> {
  const searchParams = new URLSearchParams()
  if (params?.days) searchParams.set("days", String(params.days))
  if (params?.sort) searchParams.set("sort", params.sort)
  if (params?.order) searchParams.set("order", params.order)
  if (params?.limit) searchParams.set("limit", String(params.limit))
  const qs = searchParams.toString()
  const res = await apiFetch(`${getServerUrl()}/api/archive/workflow-stats${qs ? `?${qs}` : ""}`)
  return handleResponse(res)
}

export async function fetchLessons(query: string, params?: {
  project?: string
  type?: "bug" | "pattern" | "cost" | "failure"
  status?: string
  limit?: number
}): Promise<{ items: ExperienceLesson[], total: number }> {
  const searchParams = new URLSearchParams()
  searchParams.set("q", query)
  if (params?.project) searchParams.set("project", params.project)
  if (params?.type) searchParams.set("type", params.type)
  if (params?.status) searchParams.set("status", params.status)
  if (params?.limit) searchParams.set("limit", String(params.limit))
  const res = await apiFetch(`${getServerUrl()}/api/archive/lessons?${searchParams.toString()}`)
  return handleResponse(res)
}

export async function fetchLeaderboard(params?: {
  dimension?: "cost" | "speed" | "success_rate"
  days?: number
  limit?: number
}): Promise<{ dimension: string, entries: LeaderboardEntry[] }> {
  const searchParams = new URLSearchParams()
  if (params?.dimension) searchParams.set("dimension", params.dimension)
  if (params?.days) searchParams.set("days", String(params.days))
  if (params?.limit) searchParams.set("limit", String(params.limit))
  const qs = searchParams.toString()
  const res = await apiFetch(`${getServerUrl()}/api/archive/leaderboard${qs ? `?${qs}` : ""}`)
  return handleResponse(res)
}

// ============ Compatibility aliases (get* → fetch*) ============

export type ArchiveExecution = ArchiveExecutionItem
export type PaginatedResult<T> = { data: T[], total: number, page: number, pageSize: number }

export const getArchiveExecution = fetchArchiveExecution

export async function getArchiveExecutions(opts: {
  page?: number; pageSize?: number; workflow?: string; status?: string
  from?: string; to?: string; sort?: string; order?: string
} = {}): Promise<PaginatedResult<ArchiveExecution>> {
  const result = await fetchArchiveExecutions({
    page: opts.page,
    limit: opts.pageSize,
    workflow_ref: opts.workflow,
    status: opts.status as any,
    date_from: opts.from,
    date_to: opts.to,
    sort: opts.sort as any,
    order: opts.order as any,
  })
  return { data: result.items, total: result.total, page: result.page, pageSize: result.limit }
}

export function getWorkflowStats(days: number = 30) {
  return fetchWorkflowStats({ days })
}
