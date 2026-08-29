"use client"

import { useState, useEffect, useCallback } from "react"
import { emptyTokenUsage, addTokenUsage, totalTokens } from "@octopus/shared"
import { getServerUrl } from "@/lib/server-config"
import { subscribeSSE } from "@/lib/sse-manager"
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
  delegationResult?: {
    success: boolean
    decision?: string
    reasoning?: string
    blockReason?: string
    harnessHint?: string
    modelOverride?: string
    varPoolPatches?: Record<string, string>
    chunks?: Array<{ type: string; [key: string]: unknown }>
  }
  // blocked fields
  reason?: string
  pattern?: string
  // iteration (when node is inside a loop)
  iteration?: number
  // token usage (from delegation or intervention events)
  /** 规范用量（server 已在 /events + live SSE 出口统一为规范 4 字段，前端不再做双名防御） */
  tokenUsage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; model?: string }
}

interface UseHarnessEventsResult {
  events: ParsedHarnessEvent[]
  loading: boolean
  error: string | null
  interventionCount: number
  totalExtraTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
}

let eventCounter = 0

function parseSSEEvent(eventType: string, raw: Record<string, unknown>): ParsedHarnessEvent {
  const id = `harness-${++eventCounter}-${Date.now()}`
  const timestamp = Date.now()
  const executionId = (raw.executionId as string) ?? ""

  // tokenUsage 为 server 规范形状（C1）：inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens(+model)
  const rawTokenUsage =
    (raw.tokenUsage as Record<string, unknown> | undefined) ??
    ((raw.result as Record<string, unknown> | undefined)?.tokenUsage as Record<string, unknown> | undefined)
  const tokenUsage = rawTokenUsage
    ? {
        inputTokens: rawTokenUsage.inputTokens as number | undefined,
        outputTokens: rawTokenUsage.outputTokens as number | undefined,
        cacheReadTokens: rawTokenUsage.cacheReadTokens as number | undefined,
        cacheCreationTokens: rawTokenUsage.cacheCreationTokens as number | undefined,
        model: rawTokenUsage.model as string | undefined,
      }
    : undefined

  switch (eventType) {
    case "harness_diagnosis":
      return {
        id,
        type: "harness_diagnosis",
        timestamp,
        executionId,
        nodeId: ((raw.report as Record<string, unknown>)?.displayNodeId ?? (raw.report as Record<string, unknown>)?.nodeId) as string | undefined,
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
        tokenUsage,
      }
    case "harness_delegation": {
      const rawResult = raw.result as Record<string, unknown> | undefined
      return {
        id,
        type: "harness_delegation",
        timestamp,
        executionId,
        nodeId: raw.nodeId as string | undefined,
        agentSessionId: raw.agentSessionId as string | undefined,
        status: raw.status as string | undefined,
        iteration: raw.iteration as number | undefined,
        delegationResult: rawResult
          ? {
              success: rawResult.success as boolean,
              decision: rawResult.decision as string | undefined,
              reasoning: rawResult.reasoning as string | undefined,
              blockReason: rawResult.blockReason as string | undefined,
              harnessHint: rawResult.harnessHint as string | undefined,
              modelOverride: rawResult.modelOverride as string | undefined,
              varPoolPatches: rawResult.varPoolPatches as Record<string, string> | undefined,
              chunks: rawResult.chunks as Array<{ type: string; [key: string]: unknown }> | undefined,
            }
          : undefined,
        tokenUsage,
      }
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
  const [error] = useState<string | null>(null)

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
            const rawTu = row.token_usage_json
              ? JSON.parse(row.token_usage_json as string) as Record<string, unknown>
              : undefined
            const tokenUsage = rawTu
              ? {
                  inputTokens: rawTu.inputTokens as number | undefined,
                  outputTokens: rawTu.outputTokens as number | undefined,
                  cacheReadTokens: rawTu.cacheReadTokens as number | undefined,
                  cacheCreationTokens: rawTu.cacheCreationTokens as number | undefined,
                  model: rawTu.model as string | undefined,
                }
              : undefined
            // For diagnosis and delegation events, prefer displayNodeId (inner failing node) from the report
            const displayNodeId = report ? (report as Record<string, unknown>).displayNodeId as string : undefined
            return {
              id: row.id as string,
              type: `harness_${eventType}` as HarnessEventType,
              timestamp: (row.timestamp as number) ?? Date.now(),
              executionId: (row.execution_id as string) ?? executionId,
              nodeId: displayNodeId ?? (row.node_id as string) ?? undefined,
              report,
              action,
              result: typeof result === "string" ? result : undefined,
              delegationResult:
                eventType === "delegation" && result && typeof result === "object"
                  ? {
                      success: (result as Record<string, unknown>).success as boolean,
                      decision: (result as Record<string, unknown>).decision as string | undefined,
                      reasoning: (result as Record<string, unknown>).reasoning as string | undefined,
                      blockReason: (result as Record<string, unknown>).blockReason as string | undefined,
                      harnessHint: (result as Record<string, unknown>).harnessHint as string | undefined,
                      modelOverride: (result as Record<string, unknown>).modelOverride as string | undefined,
                      varPoolPatches: (result as Record<string, unknown>).varPoolPatches as Record<string, string> | undefined,
                      chunks: (result as Record<string, unknown>).chunks as Array<{ type: string; [key: string]: unknown }> | undefined,
                    }
                  : undefined,
              tokenUsage,
              // Extract iteration from report for delegation events
              iteration: report ? (report as Record<string, unknown>).iteration as number | undefined : undefined,
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

  // Connect SSE for live updates (shared connection)
  useEffect(() => {
    if (!workspaceId || !executionId) {
      setLoading(false)
      return
    }

    // Fetch historical first
    fetchHistorical()

    const sseUrl = `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`
    const unsubs: Array<() => void> = []

    const harnessEventTypes: HarnessEventType[] = [
      "harness_diagnosis",
      "harness_intervention",
      "harness_delegation",
      "harness_blocked",
    ]

    for (const eventType of harnessEventTypes) {
      unsubs.push(subscribeSSE(sseUrl, eventType, (e: MessageEvent) => {
        try {
          const raw = JSON.parse(e.data)
          if (raw.executionId !== executionId) return
          // Skip delegation "start" events — only show complete/fail with results
          if (eventType === "harness_delegation" && raw.status === "start") return
          const parsed = parseSSEEvent(eventType, raw)
          setEvents((prev) => [...prev, parsed])
        } catch {
          /* skip malformed */
        }
      }))
    }

    return () => { unsubs.forEach(fn => fn()) }
  }, [workspaceId, executionId, fetchHistorical])

  // Compute derived stats — count both legacy intervention and new delegation events
  const interventionCount = events.filter(
    (e) => e.type === "harness_intervention" || e.type === "harness_delegation",
  ).length

  // C3: 五路 reduce 收编为 shared 公式单源（addTokenUsage + totalTokens）。
  // 口径变化：totalExtraTokens 旧为 in+out（漏 cache），现与全站总量同 = 四字段和。
  let usageTotals = emptyTokenUsage()
  for (const e of events) {
    if (e.tokenUsage) {
      usageTotals = addTokenUsage(usageTotals, {
        inputTokens: e.tokenUsage.inputTokens ?? 0,
        outputTokens: e.tokenUsage.outputTokens ?? 0,
        cacheReadTokens: e.tokenUsage.cacheReadTokens ?? 0,
        cacheCreationTokens: e.tokenUsage.cacheCreationTokens ?? 0,
      })
    }
  }
  const totalExtraTokens = totalTokens(usageTotals)
  const totalInputTokens = usageTotals.inputTokens
  const totalOutputTokens = usageTotals.outputTokens
  const totalCacheReadTokens = usageTotals.cacheReadTokens
  const totalCacheCreationTokens = usageTotals.cacheCreationTokens

  return { events, loading, error, interventionCount, totalExtraTokens, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens }
}
