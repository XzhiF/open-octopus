"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { getServerUrl } from "@/lib/server-config"

// ============ Types ============

export interface BudgetProgress {
  tokensPercent: number | null
  durationPercent: number | null
  costPercent: number | null
}

export interface ExecutionMetrics {
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  totalTurns: number
  budgetProgress: BudgetProgress
  errorCount: number
  isConnected: boolean
}

interface SSEMetricsPayload {
  executionId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  totalLlmTurns: number
  budgetProgress: BudgetProgress
  errorCount: number
  timestamp: string
}

interface ObservabilityResponse {
  tokens: {
    totalInput: number
    totalOutput: number
    totalCache: number
    totalCostUsd: number
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
  totalCost: 0,
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
 * KD-10: Independent from useHarnessEvents — harness events ≠ execution metrics.
 */
export function useExecutionMetrics(
  workspaceId: string,
  executionId: string,
): ExecutionMetrics {
  const [metrics, setMetrics] = useState<ExecutionMetrics>(INITIAL_METRICS)
  const esRef = useRef<EventSource | null>(null)

  // Fetch initial historical data from observability API
  const fetchInitial = useCallback(async () => {
    if (!workspaceId || !executionId) return
    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/observability`,
      )
      if (!res.ok) return
      const data: ObservabilityResponse = await res.json()

      setMetrics((prev) => ({
        totalTokens: data.tokens.totalInput + data.tokens.totalOutput,
        totalInputTokens: data.tokens.totalInput,
        totalOutputTokens: data.tokens.totalOutput,
        totalCost: data.tokens.totalCostUsd,
        totalTurns: data.rounds.totalLlmTurns,
        budgetProgress: data.budget.progress,
        errorCount: data.errors.length,
        isConnected: prev.isConnected,
      }))
    } catch (err) {
      // Non-fatal: SSE will pick up live events
      console.warn("[useExecutionMetrics] Failed to fetch initial observability data:", err)
    }
  }, [workspaceId, executionId])

  // Reset metrics when execution changes
  useEffect(() => {
    setMetrics(INITIAL_METRICS)
  }, [executionId])

  // Connect SSE + fetch initial data
  useEffect(() => {
    if (!workspaceId || !executionId) return

    // Fetch historical data first
    fetchInitial()

    // Subscribe to SSE for live updates
    const es = new EventSource(
      `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`,
    )
    esRef.current = es

    es.addEventListener("execution_metrics", (e: MessageEvent) => {
      try {
        const raw: SSEMetricsPayload = JSON.parse(e.data)
        // Filter by executionId
        if (raw.executionId !== executionId) return

        setMetrics({
          totalTokens: raw.totalInputTokens + raw.totalOutputTokens,
          totalInputTokens: raw.totalInputTokens,
          totalOutputTokens: raw.totalOutputTokens,
          totalCost: raw.totalCostUsd,
          totalTurns: raw.totalLlmTurns,
          budgetProgress: raw.budgetProgress,
          errorCount: raw.errorCount,
          isConnected: true,
        })
      } catch {
        /* skip malformed events */
      }
    })

    es.addEventListener("error", () => {
      setMetrics((prev) => ({ ...prev, isConnected: false }))
    })

    // Mark connected once the SSE opens
    es.addEventListener("open", () => {
      setMetrics((prev) => ({ ...prev, isConnected: true }))
    })

    return () => {
      es.close()
      esRef.current = null
    }
  }, [workspaceId, executionId, fetchInitial])

  return metrics
}
