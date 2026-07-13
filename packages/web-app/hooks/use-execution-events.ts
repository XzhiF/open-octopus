"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { fetchAgentEvents } from "@/lib/api-client"
import { isMergedEvent, type AgentEvent, type LoopIterationSummary } from "@/lib/types"

const POLL_INTERVAL_MS = 2000
const RUNNING_STATUSES = new Set(["running", "paused"])

export interface EventGroup {
  key: string
  nodeId: string
  iteration?: number
  events: AgentEvent[]
}

interface UseExecutionEventsResult {
  events: AgentEvent[]
  loopIterations: Record<string, LoopIterationSummary>
  groups: EventGroup[]
  loading: boolean
  error: string | null
}

export function useExecutionEvents(
  workspaceId: string,
  executionId: string,
  executionStatus?: string,
): UseExecutionEventsResult {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [loopIterations, setLoopIterations] = useState<Record<string, LoopIterationSummary>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const prevStatusRef = useRef(executionStatus)

  const doFetch = useCallback(async () => {
    try {
      const data = await fetchAgentEvents(workspaceId, executionId)
      setEvents(data.events ?? [])
      setLoopIterations(data.loopIterations ?? {})
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, executionId])

  // Initial fetch
  useEffect(() => {
    setLoading(true)
    doFetch().finally(() => setLoading(false))
  }, [doFetch])

  // Poll when running
  useEffect(() => {
    if (!RUNNING_STATUSES.has(executionStatus ?? "")) return
    const interval = setInterval(doFetch, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [executionStatus, doFetch])

  // Final fetch on transition to terminal
  useEffect(() => {
    const wasRunning = RUNNING_STATUSES.has(prevStatusRef.current ?? "")
    const isDone = !RUNNING_STATUSES.has(executionStatus ?? "")
    if (wasRunning && isDone) {
      doFetch()
    }
    prevStatusRef.current = executionStatus
  }, [executionStatus, doFetch])

  // Group events by nodeId + iteration
  const groups = useMemo(() => {
    const map = new Map<string, EventGroup>()

    for (const e of events) {
      // Skip merged events that belong to an iteration — they'll be in iteration groups
      const hasIteration = e.iteration != null && e.iteration > 0
      const key = hasIteration
        ? `${e.nodeId}-iter-${e.iteration}`
        : e.nodeId || "(未分类)"

      if (!map.has(key)) {
        map.set(key, {
          key,
          nodeId: e.nodeId || "(未分类)",
          iteration: hasIteration ? e.iteration : undefined,
          events: [],
        })
      }
      map.get(key)!.events.push(e)
    }

    return Array.from(map.values())
  }, [events])

  return { events, loopIterations, groups, loading, error }
}
