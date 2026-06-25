import { useState, useEffect, useRef } from "react"
import type { NodeTraceData, TurnGroup, AgentTraceEvent } from "@/lib/types"
import { fetchAgentTraces } from "@/lib/observability-api"
import { getServerUrl } from "@/lib/server-config"

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

interface LiveAgentEvent {
  executionId: string
  nodeId: string
  event: AgentTraceEvent
}

const listeners = new Set<{ executionId: string; nodeId: string; onEvents: (events: AgentTraceEvent[]) => void }>()
const eventBuffer: LiveAgentEvent[] = []

export function registerAgentEventListener(executionId: string, nodeId: string, onEvents: (events: AgentTraceEvent[]) => void) {
  const listener = { executionId, nodeId, onEvents }
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function pushAgentEvents(events: LiveAgentEvent[]) {
  for (const item of events) {
    eventBuffer.push(item)
  }
}

export function flushAgentEvents() {
  if (eventBuffer.length === 0) return
  const batch = eventBuffer.splice(0)
  for (const item of batch) {
    for (const listener of listeners) {
      if (listener.executionId === item.executionId && listener.nodeId === item.nodeId) {
        listener.onEvents([item.event])
      }
    }
  }
}

export function useAgentEventsLive(executionId: string, nodeId: string) {
  const [liveTurns, setLiveTurns] = useState<TurnGroup[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [missedCount, setMissedCount] = useState(0)
  const turnMapRef = useRef<Map<number, AgentTraceEvent[]>>(new Map())

  useEffect(() => {
    const onEvents = (events: AgentTraceEvent[]) => {
      setIsStreaming(true)
      for (const event of events) {
        const turnIndex = event.turn_index
        if (!turnMapRef.current.has(turnIndex)) {
          turnMapRef.current.set(turnIndex, [])
        }
        turnMapRef.current.get(turnIndex)!.push(event)
      }

      const newTurns: TurnGroup[] = []
      for (const [turnIndex, events] of turnMapRef.current.entries()) {
        newTurns.push({ turn_index: turnIndex, events, eventCount: events.length })
      }
      newTurns.sort((a, b) => a.turn_index - b.turn_index)
      setLiveTurns(newTurns)

      setTimeout(() => setIsStreaming(false), 200)
    }

    return registerAgentEventListener(executionId, nodeId, onEvents)
  }, [executionId, nodeId])

  return { liveTurns, isStreaming, missedCount }
}
