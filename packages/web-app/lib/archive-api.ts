import { getServerUrl } from "@/lib/server-config"
import type {
  ArchiveStats,
  ArchiveExecution,
  ArchivePaginatedResult,
  ArchiveExecutionDetail,
  CostTrendPoint,
  CostTrendSummary,
  WorkflowStat,
  ExperienceItem,
  LeaderboardEntry,
} from "@octopus/shared"

// Re-export for consumers that imported types from here
export type {
  ArchiveStats,
  ArchiveExecution,
  ArchivePaginatedResult as PaginatedResult,
  ArchiveExecutionDetail,
  CostTrendPoint,
  WorkflowStat,
  ExperienceItem,
  LeaderboardEntry,
}

function getOrg(): string {
  if (typeof window !== "undefined") {
    return localStorage.getItem("octopus-org") || "xzf"
  }
  return "xzf"
}

async function archiveFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (!headers.has("X-Octopus-Org")) {
    headers.set("X-Octopus-Org", getOrg())
  }
  return fetch(url, { ...init, headers, credentials: "include" })
}

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
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
} = {}): Promise<ArchivePaginatedResult<ArchiveExecution>> {
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
  const res = await archiveFetch(`${base()}/executions/${encodeURIComponent(id)}`)
  return handleJson(res)
}

export async function getCostTrends(days: number = 7, workspaceId?: string): Promise<{ trends: CostTrendPoint[]; summary: CostTrendSummary }> {
  const params = new URLSearchParams({ days: String(days) })
  if (workspaceId) params.set("workspace_id", workspaceId)
  const res = await archiveFetch(`${base()}/cost-trends?${params}`)
  return handleJson(res)
}

export async function getWorkflowStats(days: number = 30): Promise<{ workflows: WorkflowStat[] }> {
  const res = await archiveFetch(`${base()}/workflow-stats?days=${days}`)
  return handleJson(res)
}

export async function searchLessons(query?: string, opts?: { project?: string; type?: string; limit?: number }): Promise<{ lessons: ExperienceItem[]; total: number }> {
  const params = new URLSearchParams({ limit: String(opts?.limit ?? 20) })
  if (query) params.set("q", query)
  if (opts?.project) params.set("project", opts.project)
  if (opts?.type) params.set("type", opts.type)
  const res = await archiveFetch(`${base()}/lessons?${params}`)
  return handleJson(res)
}

export async function getLeaderboard(by: "count" | "success_rate" | "cost" = "count", days: number = 30, limit: number = 10): Promise<{ entries: LeaderboardEntry[] }> {
  const res = await archiveFetch(`${base()}/leaderboard?by=${by}&days=${days}&limit=${limit}`)
  return handleJson(res)
}
