import { useState, useEffect } from "react"
import type { LLMCallData, LLMCallAggregates } from "@/lib/types"
import { fetchLLMCalls } from "@/lib/observability-api"

export function useLLMCalls(executionId: string, nodeId?: string) {
  const [calls, setCalls] = useState<LLMCallData[]>([])
  const [aggregates, setAggregates] = useState<LLMCallAggregates>({
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: 0,
    cacheHitRate: 0,
    modelBreakdown: {},
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    fetchLLMCalls(executionId, nodeId)
      .then(result => {
        if (!cancelled) {
          setCalls(result.data ?? [])
          setAggregates(result.aggregates ?? {
            totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
            totalCost: 0, cacheHitRate: 0, modelBreakdown: {},
          })
        }
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [executionId, nodeId])

  return { calls, aggregates, loading, error }
}
