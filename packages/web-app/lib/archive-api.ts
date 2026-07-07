import { getServerUrl } from "@/lib/server-config"

async function handleResponse(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}

export interface ArchiveStats {
  total_executions: number
  total_cost: number
  avg_duration_ms: number
  avg_cost_per_execution: number
  success_rate: number
  archived_workspaces: number
  archived_workspace_cost: number
}

export interface CostTrend {
  date: string
  cost: number
  execution_count: number
}

export interface WorkflowStat {
  workflow_name: string
  execution_count: number
  success_rate: number
  avg_duration_ms: number
  avg_cost: number
}

export interface LeaderboardEntry {
  workflow_name: string
  metric_value: number
  execution_count: number
}

export async function getArchiveStats(workspaceId?: string): Promise<ArchiveStats> {
  const params = new URLSearchParams()
  if (workspaceId) params.set("workspace_id", workspaceId)
  const qs = params.toString()
  const res = await apiFetch(`${getServerUrl()}/api/archive/stats${qs ? `?${qs}` : ""}`)
  return handleResponse(res)
}

export async function getCostTrends(
  period: "7d" | "30d" | "90d" = "30d",
  workflowName?: string,
): Promise<{ period: string; data: CostTrend[] }> {
  const params = new URLSearchParams({ period })
  if (workflowName) params.set("workflow_name", workflowName)
  const res = await apiFetch(`${getServerUrl()}/api/archive/cost-trends?${params}`)
  return handleResponse(res)
}

export async function getWorkflowStats(): Promise<{ data: WorkflowStat[] }> {
  const res = await apiFetch(`${getServerUrl()}/api/archive/workflow-stats`)
  return handleResponse(res)
}

export async function getLeaderboard(
  metric: "cost" | "duration" | "frequency" = "cost",
  limit: number = 10,
): Promise<{ metric: string; limit: number; data: LeaderboardEntry[] }> {
  const params = new URLSearchParams({ metric, limit: String(limit) })
  const res = await apiFetch(`${getServerUrl()}/api/archive/leaderboard?${params}`)
  return handleResponse(res)
}
