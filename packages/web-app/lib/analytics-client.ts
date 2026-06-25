import { getServerUrl } from "@/lib/server-config"
import type { HealthSummary, Alert, ErrorCategory, FragilityScore, FailureChain, DurationAnomaly, ConsecutiveFailure, CostAnomaly, CostTrendPoint, TokenDistribution, WorkflowCost, LogContext } from "@/lib/analytics-types"

async function handleResponse(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function base(workspaceId: string) {
  return `${getServerUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/analytics`
}

export function getHealthSummary(workspaceId: string, signal?: AbortSignal): Promise<HealthSummary> {
  return fetch(`${base(workspaceId)}/health-summary`, { signal }).then(handleResponse)
}

export function getAlerts(workspaceId: string, days = 30, limit = 50, signal?: AbortSignal): Promise<Alert[]> {
  return fetch(`${base(workspaceId)}/alerts?days=${days}&limit=${limit}`, { signal }).then(handleResponse)
}

export function getFailurePatterns(workspaceId: string, days = 30, signal?: AbortSignal): Promise<{ errorCategories: ErrorCategory[]; fragilityRanking: FragilityScore[]; failureChains: FailureChain[] }> {
  return fetch(`${base(workspaceId)}/failure-patterns?days=${days}`, { signal }).then(handleResponse)
}

export function getAnomalies(workspaceId: string, days = 30, signal?: AbortSignal): Promise<{ durationAnomalies: DurationAnomaly[]; consecutiveFailures: ConsecutiveFailure[]; costAnomalies: CostAnomaly[] }> {
  return fetch(`${base(workspaceId)}/anomalies?days=${days}`, { signal }).then(handleResponse)
}

export function getCostAnalysis(workspaceId: string, days = 30, signal?: AbortSignal): Promise<{ costTrend: CostTrendPoint[]; tokenDistribution: TokenDistribution[]; costByWorkflow: WorkflowCost[] }> {
  return fetch(`${base(workspaceId)}/cost-analysis?days=${days}`, { signal }).then(handleResponse)
}

export function getExecutionLogs(workspaceId: string, executionId: string, nodeId?: string, signal?: AbortSignal): Promise<LogContext> {
  const params = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""
  return fetch(`${base(workspaceId)}/execution/${encodeURIComponent(executionId)}/logs${params}`, { signal }).then(handleResponse)
}
