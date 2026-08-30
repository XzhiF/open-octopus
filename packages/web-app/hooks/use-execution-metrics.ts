"use client"

import { useState, useEffect, useCallback } from "react"
import { getServerUrl } from "@/lib/server-config"
import { subscribeSSE } from "@/lib/sse-manager"

// ============ Types ============

export interface BudgetProgress {
  tokensPercent: number | null
  durationPercent: number | null
  costPercent: number | null
}

export interface ExecutionMetrics {
  /** C3: 全部总量字段由 server ledger totals 直供，前端零公式 */
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  /** null = 未定价（显示 —）；complete=false = 部分和（显示 ≈） */
  totalCost: number | null
  costComplete: boolean
  cacheHitRate: number | null
  totalTurns: number
  budgetProgress: BudgetProgress
  errorCount: number
  isConnected: boolean
}

interface LedgerTotalsWire {
  tokens: number
  cost: { usd: number | null; complete: boolean }
  cacheHitRate: number | null
}

interface UsageWire { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

interface SSEMetricsPayload {
  executionId: string
  usage: UsageWire
  totals: LedgerTotalsWire
  totalLlmTurns: number
  budgetProgress: BudgetProgress
  errorCount: number
  timestamp: string
}

interface ObservabilityResponse {
  tokens: {
    usage: UsageWire
    totals: LedgerTotalsWire
  }
  budget: {
    snapshot: { max_tokens?: number; max_duration?: number; max_cost_usd?: number } | null
    progress: BudgetProgress
    alerts: Array<unknown>
  }
  errors: Array<unknown>
  rounds: {
    totalLlmTurns: number
    totalLoopIterations: number
    totalSwarmRounds: number
    totalRetries: number
  }
}

// ============ Initial State ============

const INITIAL_METRICS: ExecutionMetrics = {
  totalTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalCost: null,
  costComplete: true,
  cacheHitRate: null,
  totalTurns: 0,
  budgetProgress: { tokensPercent: null, durationPercent: null, costPercent: null },
  errorCount: 0,
  isConnected: false,
}

// ============ Hook ============

/**
 * Subscribes to `execution_metrics` SSE events for a given execution,
 * and fetches initial state from the observability REST API on mount.
 *
 * Uses shared SSE connection manager to avoid exhausting browser connection pool.
 */
export function useExecutionMetrics(
  workspaceId: string,
  executionId: string,
): ExecutionMetrics {
  const [metrics, setMetrics] = useState<ExecutionMetrics>(INITIAL_METRICS)

  // Fetch initial historical data from observability API
  const fetchInitial = useCallback(async () => {
    if (!workspaceId || !executionId) return
    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/observability`,
      )
      if (!res.ok) return
      const data: ObservabilityResponse = await res.json()

      setMetrics({
        totalTokens: data.tokens.totals.tokens,
        totalInputTokens: data.tokens.usage.inputTokens,
        totalOutputTokens: data.tokens.usage.outputTokens,
        totalCacheReadTokens: data.tokens.usage.cacheReadTokens,
        totalCacheCreationTokens: data.tokens.usage.cacheCreationTokens,
        totalCost: data.tokens.totals.cost.usd,
        costComplete: data.tokens.totals.cost.complete,
        cacheHitRate: data.tokens.totals.cacheHitRate,
        totalTurns: data.rounds.totalLlmTurns,
        budgetProgress: data.budget.progress,
        errorCount: data.errors.length,
        isConnected: true,
      })
    } catch (err) {
      console.warn("[useExecutionMetrics] Failed to fetch initial observability data:", err)
    }
  }, [workspaceId, executionId])

  // Reset metrics when execution changes
  useEffect(() => {
    setMetrics(INITIAL_METRICS)
  }, [executionId])

  // Connect SSE + fetch initial data (shared connection)
  useEffect(() => {
    if (!workspaceId || !executionId) return

    fetchInitial()

    const sseUrl = `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`

    const unsub = subscribeSSE(sseUrl, "execution_metrics", (e: MessageEvent) => {
      try {
        const raw: SSEMetricsPayload = JSON.parse(e.data)
        if (raw.executionId !== executionId) return

        setMetrics({
          totalTokens: raw.totals.tokens,
          totalInputTokens: raw.usage.inputTokens,
          totalOutputTokens: raw.usage.outputTokens,
          totalCacheReadTokens: raw.usage.cacheReadTokens,
          totalCacheCreationTokens: raw.usage.cacheCreationTokens,
          totalCost: raw.totals.cost.usd,
          costComplete: raw.totals.cost.complete,
          cacheHitRate: raw.totals.cacheHitRate,
          totalTurns: raw.totalLlmTurns,
          budgetProgress: raw.budgetProgress,
          errorCount: raw.errorCount,
          isConnected: true,
        })
      } catch {
        /* skip malformed events */
      }
    })

    return unsub
  }, [workspaceId, executionId, fetchInitial])

  return metrics
}
