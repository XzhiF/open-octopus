import { useState, useEffect } from "react"
import type { TurnGroup } from "@/lib/types"
import { fetchAgentTraces } from "@/lib/observability-api"

export function useAgentTraces(executionId: string, nodeId?: string) {
  const [turns, setTurns] = useState<TurnGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [isDegraded, setIsDegraded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    fetchAgentTraces(executionId, nodeId)
      .then(result => {
        if (cancelled) return
        if (result._degraded) setIsDegraded(true)

        const allTurns: TurnGroup[] = []
        for (const nodeTrace of (result.data ?? [])) {
          if (nodeId && nodeTrace.node_id !== nodeId) continue
          for (const turn of nodeTrace.turns) {
            allTurns.push(turn)
          }
        }
        allTurns.sort((a, b) => a.turn_index - b.turn_index)
        setTurns(allTurns)
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [executionId, nodeId])

  return { turns, loading, error, isDegraded }
}

