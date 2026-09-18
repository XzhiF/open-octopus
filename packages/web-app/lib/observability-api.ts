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
  if (!res.ok) return { data: [], aggregates: { totalCalls: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null }, modelBreakdown: {} } }
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
