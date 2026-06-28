import { getServerUrl } from "@/lib/server-config"

async function archiveFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ============ Types ============

export interface ArchiveStats {
  total_executions: number
  total_cost_usd: number
  today_cost_usd: number
  week_cost_usd: number
  month_cost_usd: number
  top_workflows: {
    workflow_ref: string
    workflow_name: string
    execution_count: number
    total_cost_usd: number
  }[]
}

export interface ArchiveExecution {
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

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

export interface ArchiveExecutionDetail extends ArchiveExecution {
  org: string
  node_summary: {
    nodeId: string
    type: string
    status: string
    duration_ms: number | null
  }[]
  failed_nodes: string[] | null
  error_message: string | null
  model_breakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }> | null
  vars_snapshot: Record<string, unknown>
  lessons_learned: string | null
  workspace_archive_id: string | null
  schedule_id: string | null
  clone_name: string | null
  experiences: {
    id: string
    type: string
    title: string
    content: string
    relevance_score: number
  }[]
}

export interface CostTrendPoint {
  date: string
  total_cost_usd: number
  execution_count: number
}

export interface WorkflowStat {
  workflow_ref: string
  workflow_name: string
  execution_count: number
  success_count: number
  failed_count: number
  success_rate: number
  total_cost_usd: number
  avg_cost_usd: number
  avg_duration_ms: number
  last_executed_at: string | null
}

export interface ExperienceItem {
  id: string
  type: "bug" | "pattern" | "cost" | "failure"
  title: string
  content: string
  status: "active" | "resolved" | "obsolete" | "superseded"
  project: string | null
  package: string | null
  file_pattern: string | null
  keywords: string[]
  relevance_score: number
  use_count: number
  workflow_name: string | null
  archive_id: string | null
  created_at: string
  updated_at: string
}

export interface LeaderboardEntry {
  rank: number
  workflow_ref: string
  workflow_name: string
  execution_count: number
  success_rate: number
  total_cost_usd: number
  avg_duration_ms: number
}

// ============ API Functions ============

const base = () => `${getServerUrl()}/api/archive`

export async function getArchiveStats(): Promise<ArchiveStats> {
  const res = await archiveFetch(`${base()}/stats`)
  return handleJson(res)
}

export async function getArchiveExecutions(opts: {
  page?: number; pageSize?: number; workflow?: string; status?: string;
  from?: string; to?: string; sort?: string; order?: string
} = {}): Promise<PaginatedResult<ArchiveExecution>> {
  const params = new URLSearchParams()
  if (opts.page) params.set("page", String(opts.page))
  if (opts.pageSize) params.set("pageSize", String(opts.pageSize))
  if (opts.workflow) params.set("workflow", opts.workflow)
  if (opts.status) params.set("status", opts.status)
  if (opts.from) params.set("from", opts.from)
  if (opts.to) params.set("to", opts.to)
  if (opts.sort) params.set("sort", opts.sort)
  if (opts.order) params.set("order", opts.order)
  const qs = params.toString()
  const res = await archiveFetch(`${base()}/executions${qs ? `?${qs}` : ""}`)
  return handleJson(res)
}

export async function getArchiveExecution(id: string): Promise<ArchiveExecutionDetail> {
  const res = await archiveFetch(`${base()}/executions/${id}`)
  return handleJson(res)
}

export async function getCostTrends(days: number = 7, workspaceId?: string): Promise<{ trends: CostTrendPoint[]; summary: { total_cost_usd: number; avg_daily_cost_usd: number; max_daily_cost_usd: number } }> {
  const params = new URLSearchParams({ days: String(days) })
  if (workspaceId) params.set("workspace_id", workspaceId)
  const res = await archiveFetch(`${base()}/cost-trends?${params}`)
  return handleJson(res)
}

export async function getWorkflowStats(days: number = 30): Promise<{ workflows: WorkflowStat[] }> {
  const res = await archiveFetch(`${base()}/workflow-stats?days=${days}`)
  return handleJson(res)
}

export async function searchLessons(query?: string, limit: number = 20): Promise<{ lessons: ExperienceItem[]; total: number }> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (query) params.set("q", query)
  const res = await archiveFetch(`${base()}/lessons?${params}`)
  return handleJson(res)
}

export async function getLeaderboard(by: "count" | "success_rate" | "cost" = "count", limit: number = 10): Promise<{ entries: LeaderboardEntry[] }> {
  const res = await archiveFetch(`${base()}/leaderboard?by=${by}&limit=${limit}`)
  return handleJson(res)
}
