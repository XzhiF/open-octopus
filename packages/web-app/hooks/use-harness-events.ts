"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { getServerUrl } from "@/lib/server-config"
import type { DiagnosisReport, InterventionAction } from "@/lib/types"

// ============ Harness Event Types ============

export type HarnessEventType =
  | "harness_diagnosis"
  | "harness_intervention"
  | "harness_delegation"
  | "harness_blocked"

export interface ParsedHarnessEvent {
  id: string
  type: HarnessEventType
  timestamp: number
  executionId: string
  nodeId?: string
  // diagnosis fields
  report?: DiagnosisReport
  // intervention fields
  action?: InterventionAction
  result?: string
  // delegation fields
  agentSessionId?: string
  status?: string
  // blocked fields
  reason?: string
  pattern?: string
}

interface UseHarnessEventsResult {
  events: ParsedHarnessEvent[]
  loading: boolean
  error: string | null
  interventionCount: number
  totalExtraTokens: number
}

let eventCounter = 0

function parseSSEEvent(eventType: string, raw: Record<string, unknown>): ParsedHarnessEvent {
  const id = `harness-${++eventCounter}-${Date.now()}`
  const timestamp = Date.now()
  const executionId = (raw.executionId as string) ?? ""

  switch (eventType) {
    case "harness_diagnosis":
      return {
        id,
        type: "harness_diagnosis",
        timestamp,
        executionId,
        nodeId: (raw.report as Record<string, unknown>)?.nodeId as string | undefined,
        report: raw.report as DiagnosisReport,
      }
    case "harness_intervention":
      return {
        id,
        type: "harness_intervention",
        timestamp,
        executionId,
        nodeId: raw.nodeId as string | undefined,
        action: raw.action as InterventionAction,
        result: raw.result as string | undefined,
      }
    case "harness_delegation":
      return {
        id,
        type: "harness_delegation",
        timestamp,
        executionId,
        nodeId: raw.nodeId as string | undefined,
        agentSessionId: raw.agentSessionId as string | undefined,
        status: raw.status as string | undefined,
      }
    case "harness_blocked":
      return {
        id,
        type: "harness_blocked",
        timestamp,
        executionId,
        nodeId: raw.nodeId as string | undefined,
        reason: raw.reason as string | undefined,
        pattern: raw.pattern as string | undefined,
      }
    default:
      return { id, type: eventType as HarnessEventType, timestamp, executionId }
  }
}

export function useHarnessEvents(
  workspaceId: string,
  executionId: string,
  executionStatus?: string,
): UseHarnessEventsResult {
  const [events, setEvents] = useState<ParsedHarnessEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // Reset events when execution changes
  useEffect(() => {
    setEvents([])
    setLoading(true)
  }, [executionId])

  // Fetch historical events via REST API
  const fetchHistorical = useCallback(async () => {
    if (!workspaceId || !executionId) {
      setLoading(false)
      return
    }
    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/harness/events/${executionId}`,
      )
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data.events)) {
          const parsed: ParsedHarnessEvent[] = data.events.map((row: Record<string, unknown>) => {
            const eventType = row.event_type as string
            const report = row.report_json ? JSON.parse(row.report_json as string) : undefined
            const action = row.action_json ? JSON.parse(row.action_json as string) : undefined
            const result = row.result_json ? JSON.parse(row.result_json as string) : undefined
            return {
              id: row.id as string,
              type: `harness_${eventType}` as HarnessEventType,
              timestamp: (row.timestamp as number) ?? Date.now(),
              executionId: (row.execution_id as string) ?? executionId,
              nodeId: (row.node_id as string) ?? undefined,
              report,
              action,
              result: typeof result === "string" ? result : undefined,
            }
          })
          setEvents(parsed)
        }
      }
    } catch (err) {
      // Non-fatal: SSE will pick up live events
      console.warn("Failed to fetch historical harness events:", err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId, executionId])

  // Connect SSE for live updates
  useEffect(() => {
    if (!workspaceId || !executionId) {
      setLoading(false)
      return
    }

    // Fetch historical first
    fetchHistorical()

    const es = new EventSource(
      `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`,
    )
    esRef.current = es

    const harnessEventTypes: HarnessEventType[] = [
      "harness_diagnosis",
      "harness_intervention",
      "harness_delegation",
      "harness_blocked",
    ]

    for (const eventType of harnessEventTypes) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const raw = JSON.parse(e.data)
          if (raw.executionId !== executionId) return
          const parsed = parseSSEEvent(eventType, raw)
          setEvents((prev) => [...prev, parsed])
        } catch {
          /* skip malformed */
        }
      })
    }

    es.addEventListener("error", () => {
      setError("SSE connection error")
    })

    return () => {
      es.close()
      esRef.current = null
    }
  }, [workspaceId, executionId, fetchHistorical])

  // Compute derived stats
  const interventionCount = events.filter(
    (e) => e.type === "harness_intervention",
  ).length

  const totalExtraTokens = events.reduce((sum, e) => {
    if (e.report?.context?.nodeDurationMs) {
      // Rough token estimate from harness agent delegation events
      return sum
    }
    return sum
  }, 0)

  return { events, loading, error, interventionCount, totalExtraTokens }
}
