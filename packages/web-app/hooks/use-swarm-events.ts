"use client"

import { useEffect, useReducer, useRef, useCallback, type Dispatch } from "react"
import { getServerUrl } from "@/lib/server-config"
import type {
  ExpertInfo,
  ExpertStatus,
  SwarmMessage,
  ConsensusDataPoint,
  RouterDecision,
  TaskBreakdown,
  SwarmMode,
  SwarmStatus,
  SwarmCompleteEvent,
  FileConflict,
} from "@/lib/swarm-types"

interface SwarmState {
  status: SwarmStatus
  mode: SwarmMode | null
  experts: Map<string, ExpertInfo>
  messages: SwarmMessage[]
  consensusHistory: ConsensusDataPoint[]
  currentRound: number
  totalExperts: number
  routerDecision: RouterDecision | null
  taskBreakdown: TaskBreakdown | null
  hostReport: string | null
  hostDegraded: boolean
  fileConflicts: FileConflict[]
  finalResult: SwarmCompleteEvent["result"] | null
  budgetExhausted: boolean
  timeoutExceeded: boolean
  moaExpertResults: Array<{
    role: string
    model: string
    status: "completed" | "failed"
    outputPreview: string
    durationMs: number
    degraded: boolean
    degradationChain?: string[]
  }>
  aggregatorStatus: "idle" | "running" | "completed" | "failed"
  aggregatorRound: number
  aggregatorTotalRounds: number
  aggregatorModel: string
  aggregatorInputExpertCount: number
}

type SwarmAction =
  | { type: "expert_spawn"; payload: { role: string; model: ExpertInfo["model"]; source: ExpertInfo["source"]; nodeId: string } }
  | { type: "expert_message"; payload: { role: string; round: number; content: string; tokens: number } }
  | { type: "expert_complete"; payload: { role: string; status: ExpertStatus; output: string; tokens: number; inputTokens: number; outputTokens: number; model?: string } }
  | { type: "consensus_check"; payload: { round: number; score: number; shouldContinue: boolean } }
  | { type: "round_end"; payload: { round: number; expertCount: number } }
  | { type: "swarm_complete"; payload: SwarmCompleteEvent }
  | { type: "mode_detected"; payload: { mode: SwarmMode } }
  | { type: "router_decision"; payload: RouterDecision }
  | { type: "task_breakdown"; payload: TaskBreakdown }
  | { type: "file_conflict"; payload: FileConflict }
  | { type: "host_report"; payload: { content: string; degraded: boolean } }
  | { type: "moa_expert_complete"; payload: { role: string; model: string; status: "completed" | "failed"; outputPreview: string; durationMs: number; degraded: boolean; degradationChain?: string[] } }
  | { type: "moa_aggregator_start"; payload: { round: number; totalRounds: number; model: string; inputExpertCount: number } }
  | { type: "moa_aggregator_complete"; payload: { round: number; totalRounds: number; model: string; inputExpertCount: number } }
  | { type: "reset" }

const initialState: SwarmState = {
  status: "initializing",
  mode: null,
  experts: new Map(),
  messages: [],
  consensusHistory: [],
  currentRound: 0,
  totalExperts: 0,
  routerDecision: null,
  taskBreakdown: null,
  hostReport: null,
  hostDegraded: false,
  fileConflicts: [],
  finalResult: null,
  budgetExhausted: false,
  timeoutExceeded: false,
  moaExpertResults: [],
  aggregatorStatus: "idle" as const,
  aggregatorRound: 0,
  aggregatorTotalRounds: 0,
  aggregatorModel: "",
  aggregatorInputExpertCount: 0,
}

function swarmReducer(state: SwarmState, action: SwarmAction): SwarmState {
  switch (action.type) {
    case "reset":
      return { ...initialState, experts: new Map() }

    case "mode_detected":
      return { ...state, mode: action.payload.mode }

    case "expert_spawn": {
      const { role, model, source } = action.payload
      const nextExperts = new Map(state.experts)
      const existing = nextExperts.get(role)
      nextExperts.set(role, {
        role,
        status: "running",
        model,
        source,
        tokensConsumed: existing?.tokensConsumed ?? 0,
        inputTokens: existing?.inputTokens ?? 0,
        outputTokens: existing?.outputTokens ?? 0,
        attempts: (existing?.attempts ?? 0) + 1,
        output: existing?.output,
        error: null,
      })
      return {
        ...state,
        status: "running",
        experts: nextExperts,
        totalExperts: Math.max(state.totalExperts, nextExperts.size),
      }
    }

    case "expert_message": {
      const { role, round, content, tokens } = action.payload
      const msg: SwarmMessage = {
        from: role,
        round,
        content,
        timestamp: Date.now(),
        tokens,
      }
      const nextExperts = new Map(state.experts)
      const expert = nextExperts.get(role)
      if (expert) {
        nextExperts.set(role, {
          ...expert,
          tokensConsumed: expert.tokensConsumed + tokens,
        })
      }
      return {
        ...state,
        messages: [...state.messages, msg],
        currentRound: Math.max(state.currentRound, round),
        experts: nextExperts,
      }
    }

    case "expert_complete": {
      const { role, status, output, tokens, inputTokens, outputTokens, model: actualModel } = action.payload
      const nextExperts = new Map(state.experts)
      const existing = nextExperts.get(role)
      nextExperts.set(role, {
        ...(existing ?? {
          role,
          status: "pending" as ExpertStatus,
          model: "unknown",
          source: "predefined" as const,
          tokensConsumed: 0,
          inputTokens: 0,
          outputTokens: 0,
          attempts: 0,
          error: null,
        }),
        status,
        output,
        ...(actualModel ? { model: actualModel } : {}),
        tokensConsumed: tokens > 0 ? tokens : (existing?.tokensConsumed ?? 0),
        inputTokens: inputTokens ?? (existing?.inputTokens ?? 0),
        outputTokens: outputTokens ?? (existing?.outputTokens ?? 0),
        error: status === "failed" ? output : null,
      })
      return { ...state, experts: nextExperts }
    }

    case "consensus_check": {
      const { round, score, shouldContinue } = action.payload
      const point: ConsensusDataPoint = { round, score, shouldContinue }
      const existing = state.consensusHistory.findIndex(p => p.round === round)
      const nextHistory = [...state.consensusHistory]
      if (existing >= 0) {
        nextHistory[existing] = point
      } else {
        nextHistory.push(point)
      }
      return { ...state, consensusHistory: nextHistory }
    }

    case "round_end": {
      const { round, expertCount } = action.payload
      return {
        ...state,
        currentRound: Math.max(state.currentRound, round),
        totalExperts: Math.max(state.totalExperts, expertCount),
      }
    }

    case "swarm_complete": {
      const { status, synthesis, result } = action.payload
      return {
        ...state,
        status: status === "completed" ? "completed" : "failed",
        hostReport: synthesis,
        finalResult: result,
        budgetExhausted: result.budget_exhausted,
        timeoutExceeded: result.timeout_exceeded,
        hostDegraded: result.host_degraded,
      }
    }

    case "router_decision":
      return { ...state, routerDecision: action.payload }

    case "task_breakdown":
      return { ...state, taskBreakdown: action.payload }

    case "file_conflict":
      return { ...state, fileConflicts: [...state.fileConflicts, action.payload] }

    case "host_report":
      return {
        ...state,
        hostReport: action.payload.content,
        hostDegraded: action.payload.degraded,
      }

    case "moa_expert_complete": {
      const result = action.payload
      return {
        ...state,
        moaExpertResults: [...state.moaExpertResults, result],
      }
    }

    case "moa_aggregator_start":
      return {
        ...state,
        aggregatorStatus: "running",
        aggregatorRound: action.payload.round,
        aggregatorTotalRounds: action.payload.totalRounds,
        aggregatorModel: action.payload.model,
        aggregatorInputExpertCount: action.payload.inputExpertCount,
      }

    case "moa_aggregator_complete":
      return {
        ...state,
        aggregatorStatus: "completed",
        aggregatorRound: action.payload.round,
        aggregatorTotalRounds: action.payload.totalRounds,
      }

    default:
      return state
  }
}

export interface UseSwarmEventsResult {
  status: SwarmStatus
  mode: SwarmMode | null
  experts: ExpertInfo[]
  messages: SwarmMessage[]
  consensusHistory: ConsensusDataPoint[]
  currentRound: number
  totalExperts: number
  routerDecision: RouterDecision | null
  taskBreakdown: TaskBreakdown | null
  hostReport: string | null
  hostDegraded: boolean
  fileConflicts: FileConflict[]
  finalResult: SwarmCompleteEvent["result"] | null
  budgetExhausted: boolean
  timeoutExceeded: boolean
  moaExpertResults: Array<{
    role: string
    model: string
    status: "completed" | "failed"
    outputPreview: string
    durationMs: number
    degraded: boolean
    degradationChain?: string[]
  }>
  aggregatorStatus: "idle" | "running" | "completed" | "failed"
  aggregatorRound: number
  aggregatorTotalRounds: number
  aggregatorModel: string
  aggregatorInputExpertCount: number
  connected: boolean
}

/**
 * Replay historical JSONL events through the reducer to populate state
 * for already-completed executions.
 */
function replayHistoricalEvents(
  events: Array<Record<string, unknown>>,
  dispatch: Dispatch<SwarmAction>,
): void {
  for (const entry of events) {
    const event = entry.event as string
    const data = (entry.eventData ?? entry) as Record<string, unknown>

    switch (event) {
      case "start":
        if (data.type === "swarm" && data.mode) {
          dispatch({ type: "mode_detected", payload: { mode: data.mode as SwarmMode } })
        }
        break

      case "expert_spawn":
        dispatch({
          type: "expert_spawn",
          payload: {
            role: (data.role as string) ?? "unknown",
            model: ((data.model as string) ?? "sonnet") as ExpertInfo["model"],
            source: ((data.source as string) ?? "predefined") as ExpertInfo["source"],
            nodeId: (data.nodeId as string) ?? "",
          },
        })
        break

      case "expert_message": {
        const role = (data.role as string) ?? (data.from as string) ?? ""
        dispatch({
          type: "expert_message",
          payload: {
            role,
            round: (data.round as number) ?? 1,
            content: (data.content as string) ?? "",
            tokens: (data.tokens as number) ?? 0,
          },
        })
        break
      }

      case "expert_complete":
        dispatch({
          type: "expert_complete",
          payload: {
            role: (data.role as string) ?? "unknown",
            status: ((data.status as string) ?? "completed") as ExpertStatus,
            output: (data.output as string) ?? "",
            tokens: (data.tokens as number) ?? 0,
            inputTokens: (data.inputTokens as number) ?? 0,
            outputTokens: (data.outputTokens as number) ?? 0,
            model: data.model as string | undefined,
          },
        })
        break

      case "consensus_check":
        dispatch({
          type: "consensus_check",
          payload: {
            round: (data.round as number) ?? 1,
            score: (data.score as number) ?? 0,
            shouldContinue: (data.shouldContinue as boolean) ?? true,
          },
        })
        break

      case "swarm_round_end":
        dispatch({
          type: "round_end",
          payload: {
            round: (data.round as number) ?? 1,
            expertCount: (data.expertCount as number) ?? 0,
          },
        })
        break

      case "swarm_complete": {
        // Extract mode from the event for replay
        if (data.mode) {
          dispatch({ type: "mode_detected", payload: { mode: data.mode as SwarmMode } })
        }

        // Synthesis may be a JSON string (from structured output) or plain text
        let synthesisText = (data.synthesis as string) ?? ""
        try {
          const parsed = JSON.parse(synthesisText)
          if (parsed && typeof parsed === "object" && typeof parsed.synthesis === "string") {
            synthesisText = parsed.synthesis
          }
        } catch { /* not JSON, use as-is */ }

        dispatch({
          type: "swarm_complete",
          payload: {
            nodeId: (data.nodeId as string) ?? "",
            status: ((data.status as string) ?? "completed") as SwarmCompleteEvent["status"],
            synthesis: synthesisText,
            result: (data.result as SwarmCompleteEvent["result"]) ?? {
              consensus_score: null,
              rounds_used: 1,
              expert_count: 0,
              budget_exhausted: false,
              timeout_exceeded: false,
              host_degraded: false,
              failed_experts: [],
              skipped_experts: [],
            },
          },
        })
        break
      }

      case "swarm_event":
        // The actual event is nested in eventData — already handled above
        break

      case "moa_expert_complete":
        dispatch({
          type: "moa_expert_complete",
          payload: {
            role: (data.role as string) ?? "unknown",
            model: (data.model as string) ?? "unknown",
            status: ((data.status as string) ?? "completed") as "completed" | "failed",
            outputPreview: (data.outputPreview as string) ?? "",
            durationMs: (data.durationMs as number) ?? 0,
            degraded: (data.degraded as boolean) ?? false,
            degradationChain: data.degradationChain as string[] | undefined,
          },
        })
        break

      case "moa_aggregator": {
        const phase = (data.phase as string) ?? "start"
        dispatch({
          type: phase === "start" ? "moa_aggregator_start" : "moa_aggregator_complete",
          payload: {
            round: (data.round as number) ?? 1,
            totalRounds: (data.totalRounds as number) ?? 1,
            model: (data.model as string) ?? "unknown",
            inputExpertCount: (data.inputExpertCount as number) ?? 0,
          },
        })
        break
      }
    }
  }
}

export function useSwarmEvents(
  workspaceId: string,
  nodeId: string | null,
  executionId?: string,
): UseSwarmEventsResult {
  const [state, dispatch] = useReducer(swarmReducer, initialState)
  const esRef = useRef<EventSource | null>(null)
  const connectedRef = useRef(false)

  const isEventForNode = useCallback(
    (data: { nodeId?: string }) => {
      if (!nodeId) return false
      return data.nodeId === nodeId
    },
    [nodeId],
  )

  useEffect(() => {
    if (!nodeId || !workspaceId) {
      dispatch({ type: "reset" })
      return
    }

    // Phase 1: Load historical events from JSONL for completed executions
    if (executionId) {
      fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/analytics/swarm-events/${executionId}?nodeId=${nodeId}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (!data?.events?.length) return
          replayHistoricalEvents(data.events, dispatch)
        })
        .catch(() => { /* ignore — SSE will pick up live events */ })
    }

    // Phase 2: Connect SSE for live updates
    connectedRef.current = false
    const es = new EventSource(
      `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`,
    )
    esRef.current = es

    es.addEventListener("open", () => {
      connectedRef.current = true
    })

    es.addEventListener("swarm_mode", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({ type: "mode_detected", payload: { mode: data.mode } })
      } catch { /* skip */ }
    })

    es.addEventListener("expert_spawn", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "expert_spawn",
          payload: {
            role: data.role,
            model: data.model ?? "sonnet",
            source: data.source ?? "predefined",
            nodeId: data.nodeId,
          },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("expert_message", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "expert_message",
          payload: {
            role: data.role,
            round: data.round,
            content: data.content,
            tokens: data.tokens ?? 0,
          },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("expert_complete", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "expert_complete",
          payload: {
            role: data.role,
            status: data.status,
            output: data.output ?? "",
            tokens: data.tokens ?? 0,
            inputTokens: data.inputTokens ?? 0,
            outputTokens: data.outputTokens ?? 0,
            model: data.model,
          },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("consensus_check", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "consensus_check",
          payload: {
            round: data.round,
            score: data.score,
            shouldContinue: data.shouldContinue,
          },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("swarm_round_end", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "round_end",
          payload: { round: data.round, expertCount: data.expertCount },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("swarm_complete", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return

        // Extract mode from swarm_complete event
        if (data.mode) {
          dispatch({ type: "mode_detected", payload: { mode: data.mode as SwarmMode } })
        }

        // Synthesis may be a JSON string (structured output) — extract text
        let synthesis = (data.synthesis as string) ?? ""
        try {
          const parsed = JSON.parse(synthesis)
          if (parsed && typeof parsed === "object" && typeof parsed.synthesis === "string") {
            synthesis = parsed.synthesis
          }
        } catch { /* not JSON */ }

        dispatch({
          type: "swarm_complete",
          payload: { ...data, synthesis },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("router_decision", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({ type: "router_decision", payload: data })
      } catch { /* skip */ }
    })

    es.addEventListener("task_breakdown", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({ type: "task_breakdown", payload: data })
      } catch { /* skip */ }
    })

    es.addEventListener("file_conflict", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "file_conflict",
          payload: { file: data.file, experts: data.experts },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("host_report", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "host_report",
          payload: { content: data.content, degraded: data.degraded ?? false },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("moa_expert_complete", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        dispatch({
          type: "moa_expert_complete",
          payload: {
            role: data.role,
            model: data.model ?? "unknown",
            status: data.status ?? "completed",
            outputPreview: data.outputPreview ?? "",
            durationMs: data.durationMs ?? 0,
            degraded: data.degraded ?? false,
            degradationChain: data.degradationChain,
          },
        })
      } catch { /* skip */ }
    })

    es.addEventListener("moa_aggregator", (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForNode(data)) return
        const phase = data.phase as string
        dispatch({
          type: phase === "start" ? "moa_aggregator_start" : "moa_aggregator_complete",
          payload: {
            round: data.round ?? 1,
            totalRounds: data.totalRounds ?? 1,
            model: data.model ?? "unknown",
            inputExpertCount: data.inputExpertCount ?? 0,
          },
        })
      } catch { /* skip */ }
    })

    es.onerror = () => {
      connectedRef.current = false
    }

    return () => {
      es.close()
      esRef.current = null
      connectedRef.current = false
    }
  }, [workspaceId, nodeId, executionId, isEventForNode])

  const expertsArray = Array.from(state.experts.values())

  return {
    status: state.status,
    mode: state.mode,
    experts: expertsArray,
    messages: state.messages,
    consensusHistory: state.consensusHistory,
    currentRound: state.currentRound,
    totalExperts: state.totalExperts,
    routerDecision: state.routerDecision,
    taskBreakdown: state.taskBreakdown,
    hostReport: state.hostReport,
    hostDegraded: state.hostDegraded,
    fileConflicts: state.fileConflicts,
    finalResult: state.finalResult,
    budgetExhausted: state.budgetExhausted,
    timeoutExceeded: state.timeoutExceeded,
    moaExpertResults: state.moaExpertResults,
    aggregatorStatus: state.aggregatorStatus,
    aggregatorRound: state.aggregatorRound,
    aggregatorTotalRounds: state.aggregatorTotalRounds,
    aggregatorModel: state.aggregatorModel,
    aggregatorInputExpertCount: state.aggregatorInputExpertCount,
    connected: connectedRef.current,
  }
}
