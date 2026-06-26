import { getServerUrl } from "@/lib/server-config"
import type {
  ArchiveStats,
  CostTrendResponse,
  WorkflowStat,
  LeaderboardResponse,
  ArchiveExecutionListItem,
  ArchiveExecutionDetail,
  ExperienceItem,
  PaginatedResult,
} from "@octopus/shared"

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

// ============ Query Param Types ============

interface ExecutionFilters {
  page?: number
  pageSize?: number
  workflow?: string
  status?: string
  from?: string
  to?: string
  org?: string
}

interface LessonFilters {
  q?: string
  type?: string
  status?: string
  org?: string
  limit?: number
}

// ============ Archive Stats ============

export async function fetchArchiveStats(org?: string): Promise<ArchiveStats> {
  const params = new URLSearchParams()
  if (org) params.set("org", org)
  const qs = params.toString()
  const url = `${getServerUrl()}/api/archive/stats${qs ? `?${qs}` : ""}`
  const res = await apiFetch(url)
  return handleResponse<ArchiveStats>(res)
}

// ============ Cost Trends ============

export async function fetchCostTrends(
  period?: "7d" | "30d",
  org?: string,
): Promise<CostTrendResponse> {
  const params = new URLSearchParams()
  if (period) params.set("period", period)
  if (org) params.set("org", org)
  const qs = params.toString()
  const url = `${getServerUrl()}/api/archive/cost-trends${qs ? `?${qs}` : ""}`
  const res = await apiFetch(url)
  return handleResponse<CostTrendResponse>(res)
}

// ============ Workflow Stats ============

export async function fetchWorkflowStats(
  limit?: number,
  org?: string,
): Promise<WorkflowStat[]> {
  const params = new URLSearchParams()
  if (limit) params.set("limit", String(limit))
  if (org) params.set("org", org)
  const qs = params.toString()
  const url = `${getServerUrl()}/api/archive/workflows${qs ? `?${qs}` : ""}`
  const res = await apiFetch(url)
  return handleResponse<WorkflowStat[]>(res)
}

// ============ Archive Leaderboard ============

export async function fetchArchiveLeaderboard(
  limit?: number,
  org?: string,
): Promise<LeaderboardResponse> {
  const params = new URLSearchParams()
  if (limit) params.set("limit", String(limit))
  if (org) params.set("org", org)
  const qs = params.toString()
  const url = `${getServerUrl()}/api/archive/leaderboard${qs ? `?${qs}` : ""}`
  const res = await apiFetch(url)
  return handleResponse<LeaderboardResponse>(res)
}

// ============ Archive Executions ============

export async function fetchArchiveExecutions(
  filters?: ExecutionFilters,
): Promise<PaginatedResult<ArchiveExecutionListItem>> {
  const params = new URLSearchParams()
  if (filters?.page) params.set("page", String(filters.page))
  if (filters?.pageSize) params.set("pageSize", String(filters.pageSize))
  if (filters?.workflow) params.set("workflow", filters.workflow)
  if (filters?.status) params.set("status", filters.status)
  if (filters?.from) params.set("from", filters.from)
  if (filters?.to) params.set("to", filters.to)
  if (filters?.org) params.set("org", filters.org)
  const qs = params.toString()
  const url = `${getServerUrl()}/api/archive/executions${qs ? `?${qs}` : ""}`
  const res = await apiFetch(url)
  return handleResponse<PaginatedResult<ArchiveExecutionListItem>>(res)
}

// ============ Archive Execution Detail ============

export async function fetchArchiveExecutionDetail(
  id: string,
): Promise<ArchiveExecutionDetail> {
  const url = `${getServerUrl()}/api/archive/executions/${encodeURIComponent(id)}`
  const res = await apiFetch(url)
  return handleResponse<ArchiveExecutionDetail>(res)
}

// ============ Lessons Search ============

export async function searchLessons(
  filters?: LessonFilters,
): Promise<ExperienceItem[]> {
  const params = new URLSearchParams()
  if (filters?.q) params.set("q", filters.q)
  if (filters?.type) params.set("type", filters.type)
  if (filters?.status) params.set("status", filters.status)
  if (filters?.org) params.set("org", filters.org)
  if (filters?.limit) params.set("limit", String(filters.limit))
  const qs = params.toString()
  const url = `${getServerUrl()}/api/archive/lessons${qs ? `?${qs}` : ""}`
  const res = await apiFetch(url)
  return handleResponse<ExperienceItem[]>(res)
}
