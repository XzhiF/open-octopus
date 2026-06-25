import type { AgentTraceEvent, NodeTraceData, LLMCallData, LLMCallAggregates } from "@/lib/types"
import { getServerUrl } from "@/lib/server-config"

// ============ Observability ============

export async function fetchAgentTraces(
  executionId: string,
  nodeId?: string
): Promise<{ data: NodeTraceData[]; _degraded?: boolean }> {
  const url = new URL(`${getServerUrl()}/api/executions/${executionId}/traces`)
  if (nodeId) url.searchParams.set("nodeId", nodeId)
  const res = await fetch(url.toString())
  if (!res.ok) return { data: [] }
  return res.json()
}

export async function fetchLLMCalls(
  executionId: string,
  nodeId?: string
): Promise<{ data: LLMCallData[]; aggregates: LLMCallAggregates }> {
  const url = new URL(`${getServerUrl()}/api/executions/${executionId}/llm-calls`)
  if (nodeId) url.searchParams.set("nodeId", nodeId)
  const res = await fetch(url.toString())
  if (!res.ok) return { data: [], aggregates: { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalCost: 0, cacheHitRate: 0, modelBreakdown: {} } }
  return res.json()
}

// ============ Analytics ============

export async function fetchWorkspaceAnalytics(workspaceId: string, range = '7d') {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/analytics?range=${range}`)
  if (!res.ok) return { data: null, workflows: [], dailyTrend: [] }
  return res.json()
}

export async function fetchWorkflowAnalytics(workspaceId: string, workflowRef: string, range = '7d') {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/analytics/workflows/${encodeURIComponent(workflowRef)}?range=${range}`)
  if (!res.ok) return { data: null, executions: [] }
  return res.json()
}

export async function fetchCostAnalysis(workspaceId: string, range = '30d') {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/analytics/cost?range=${range}`)
  if (!res.ok) return { data: null, byModel: [], byWorkflow: [], dailyTrend: [] }
  return res.json()
}

export async function fetchSuggestions(workspaceId: string, status?: string) {
  const url = new URL(`${getServerUrl()}/api/workspaces/${workspaceId}/suggestions`)
  if (status) url.searchParams.set('status', status)
  const res = await fetch(url.toString())
  if (!res.ok) return { data: [] }
  return res.json()
}

export async function applySuggestion(workspaceId: string, suggestionId: string, changes: Record<string, unknown>) {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/suggestions/${suggestionId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  })
  if (!res.ok) return { success: false }
  return res.json()
}
