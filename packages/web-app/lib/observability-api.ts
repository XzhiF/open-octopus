import type { AgentTraceEvent, NodeTraceData, LLMCallData, LLMCallAggregates } from "@/lib/types"
import type { LlmUsageAggregates } from "@octopus/shared"
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

/**
 * 会话口径账本（v49）—— 聊天 composer 的 token 角标 / 明细 popover 数据源。
 * 零值兜底与 fetchLLMCalls 同形：拿不到账本 = 「—」的输入，不是假 0%
 * （cost 三态 usd:null/complete:true、cacheHitRate:null 由 formatCost/formatPercent 渲成「—」）。
 */
export async function fetchSessionLLMCalls(
  sessionId: string,
): Promise<{ data: LLMCallData[]; aggregates: LlmUsageAggregates }> {
  const url = new URL(`${getServerUrl()}/api/sessions/${sessionId}/llm-calls`)
  const res = await fetch(url.toString())
  if (!res.ok) {
    return {
      data: [],
      aggregates: {
        totalCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null },
        modelBreakdown: {},
      },
    }
  }
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
