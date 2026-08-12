// packages/server/src/services/execution/EngineCallbacks.ts
//
// Full-featured engine callbacks — mirrors the behavior previously inline in
// ExecutionLifecycle.buildCallbacks(). Handles SSE emission, DB persistence,
// observability integration, token tracking, and external callback dispatch.
//
import type { IEngineCallbacks } from "./interfaces"
import type { ServiceContext } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import type { EngineCallbacks as EngineCallbackType } from "@octopus/engine"
import type { PipelineConfig } from "@octopus/shared"
import type { EnginePool } from "./EnginePool"
import type { ObservabilityService } from "../observability"
import { getFlag } from "../../config/feature-flags"
import { appendFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

export interface EngineCallbacksDeps {
  ctx: ServiceContext
  dao: ExecutionDAO
  tokenUsageDao: TokenUsageDAO
  enginePool: EnginePool
  observability: ObservabilityService
  workspaceId: string           // SSE workspace ID (org:path format)
  org: string
  workspaceDbId: string
  externalCallbacks: Map<string, Partial<EngineCallbackType>>
  syncStateJson: () => void
}

export class EngineCallbacks implements IEngineCallbacks {
  private ctx: ServiceContext
  private dao: ExecutionDAO
  private tokenUsageDao: TokenUsageDAO
  private enginePool: EnginePool
  private observability: ObservabilityService
  private workspaceId: string
  private org: string
  private workspaceDbId: string
  private externalCallbacks: Map<string, Partial<EngineCallbackType>>
  private syncStateJson: () => void

  constructor(deps: EngineCallbacksDeps) {
    this.ctx = deps.ctx
    this.dao = deps.dao
    this.tokenUsageDao = deps.tokenUsageDao
    this.enginePool = deps.enginePool
    this.observability = deps.observability
    this.workspaceId = deps.workspaceId
    this.org = deps.org
    this.workspaceDbId = deps.workspaceDbId
    this.externalCallbacks = deps.externalCallbacks
    this.syncStateJson = deps.syncStateJson
  }

  buildCallbacks(executionId: string): EngineCallbackType {
    const id = executionId
    const sse = this.ctx.sse
    const dao = this.dao
    const tokenUsageDao = this.tokenUsageDao
    const enginePool = this.enginePool
    const obs = this.observability
    const wsId = this.workspaceId

    // Track branch start times for durationMs computation
    const branchStartTimes = new Map<string, number>()

    // Throttle for execution_metrics SSE: max 1 emit per 500ms (trailing edge)
    let metricsTimer: ReturnType<typeof setTimeout> | null = null

    /** Compute and emit execution_metrics SSE event (throttled, trailing edge). */
    const scheduleMetricsEmit = () => {
      // Always use trailing-edge: cancel pending timer and schedule a new one.
      // This ensures only 1 emission per 500ms window — the latest state wins.
      if (metricsTimer) {
        clearTimeout(metricsTimer)
      }
      metricsTimer = setTimeout(() => {
        metricsTimer = null
        try {
          const exec = dao.findById(id)
          const metrics = tokenUsageDao.aggregateByExecution(id)

          // Parse budget snapshot
          let budgetSnapshot: { max_tokens?: number; max_duration?: number; max_cost_usd?: number; alert_threshold?: number } | null = null
          if (exec?.budget_snapshot) {
            try { budgetSnapshot = JSON.parse(exec.budget_snapshot) } catch { /* ignore */ }
          }

          // Compute budget progress
          const totalTokens = metrics.totalInputTokens + metrics.totalOutputTokens + metrics.totalCacheTokens
          const budgetProgress: {
            tokensPercent: number | null
            durationPercent: number | null
            costPercent: number | null
          } = { tokensPercent: null, durationPercent: null, costPercent: null }

          if (budgetSnapshot) {
            if (budgetSnapshot.max_tokens) {
              budgetProgress.tokensPercent = (totalTokens / budgetSnapshot.max_tokens) * 100
            }
            if (budgetSnapshot.max_cost_usd) {
              budgetProgress.costPercent = (metrics.totalCostUsd / budgetSnapshot.max_cost_usd) * 100
            }
            if (budgetSnapshot.max_duration && exec?.started_at) {
              const elapsedMs = Date.now() - new Date(exec.started_at).getTime()
              budgetProgress.durationPercent = (elapsedMs / (budgetSnapshot.max_duration * 1000)) * 100
            }
          }

          sse.emit(wsId, {
            event: "execution_metrics",
            data: {
              executionId: id,
              totalInputTokens: metrics.totalInputTokens,
              totalOutputTokens: metrics.totalOutputTokens,
              totalCacheTokens: metrics.totalCacheTokens,
              totalCostUsd: metrics.totalCostUsd,
              totalLlmTurns: metrics.totalLlmTurns,
              budgetProgress,
              errorCount: metrics.errorCount,
              timestamp: new Date().toISOString(),
            },
          })

          // Budget warning: totalTokens > max_tokens * alert_threshold
          if (budgetSnapshot?.max_tokens) {
            const threshold = budgetSnapshot.alert_threshold ?? 0.8
            const warningLimit = budgetSnapshot.max_tokens * threshold
            if (totalTokens > warningLimit && totalTokens <= budgetSnapshot.max_tokens) {
              console.warn(
                `[EngineCallbacks] Budget warning: execution ${id} has consumed ${totalTokens}/${budgetSnapshot.max_tokens} tokens (${(totalTokens / budgetSnapshot.max_tokens * 100).toFixed(1)}%, threshold ${threshold * 100}%)`,
              )
            }
          }
        } catch (err) {
          console.error("[EngineCallbacks] Failed to emit execution_metrics:", err)
        }
      }, 500)
    }

    return {
      // ── onBeforeNode: budget blocking (BEFORE harness pipeline) ─────
      // KD-11: budget check is injected before harness wrapping.
      // The harness Proxy in DetectorPipeline intercepts onBeforeNode first,
      // runs its detectors, then falls through to this handler.
      // KD-16: only fires for top-level nodes (not loop inner nodes).
      onBeforeNode: async (nodeId: string, nodeType: string, _nodeConfig: any) => {
        try {
          const exec = dao.findById(id)
          if (!exec?.budget_snapshot) return { action: "proceed" as const }

          let budgetSnapshot: { max_tokens?: number; alert_threshold?: number }
          try { budgetSnapshot = JSON.parse(exec.budget_snapshot) } catch { return { action: "proceed" as const } }

          if (!budgetSnapshot.max_tokens) return { action: "proceed" as const }

          const metrics = tokenUsageDao.aggregateByExecution(id)
          const totalTokens = metrics.totalInputTokens + metrics.totalOutputTokens + metrics.totalCacheTokens

          if (totalTokens > budgetSnapshot.max_tokens) {
            // Budget exceeded: block this node and abort execution
            const now = new Date().toISOString()
            dao.updateExecution(id, {
              status: "budget_exceeded",
              completed_at: now,
            })
            sse.emit(wsId, {
              event: "execution_status",
              data: {
                executionId: id,
                status: "budget_exceeded",
                reason: "max_tokens exceeded",
                budgetSnapshot: { max_tokens: budgetSnapshot.max_tokens, actual: totalTokens },
              },
            })
            // Emit execution_progress to notify external listeners (dashboard, etc.)
            sse.emit(wsId, {
              event: "execution_progress",
              data: { executionId: id, status: "budget_exceeded", completedAt: now },
            })
            // Abort the engine so subsequent nodes don't run
            enginePool.cancel(id)

            return {
              action: "override" as const,
              overrideResult: {
                outputs: { error: "Budget exceeded" },
                status: "failed" as const,
                durationMs: 0,
                logLines: [`Budget exceeded: ${totalTokens}/${budgetSnapshot.max_tokens} tokens consumed`],
              },
            }
          }
        } catch (err) {
          console.error("[EngineCallbacks] Budget check in onBeforeNode failed (non-fatal):", err)
        }
        return { action: "proceed" as const }
      },

      onNodeStart: (nodeId, nodeType) => {
        const neId = `${id}-${nodeId}`
        // Clear old agent events for this node to prevent PRIMARY KEY collision
        // on event_order when retrying/restarting a node (e.g. after server restart).
        try { dao.deleteAgentEventsByNode(neId) } catch { /* non-fatal */ }
        // Reset observability buffer ordering so the next flush starts from 0,
        // matching the cleared DB state. Without this, INSERT OR IGNORE would
        // silently drop events whose event_order conflicts with preserved harness events.
        obs.resetNodeBuffer(neId)
        // Reset degraded state so the observability buffer resumes writing
        obs.resetDegraded()
        dao.updateNodeExecution(neId, { status: "running", started_at: new Date().toISOString() })
        sse.emit(wsId, {
          event: "node_start", data: { executionId: id, nodeId, nodeType, executorType: nodeType },
        })
        this.syncStateJson()
      },

      onNodeEnd: (nodeId, status, durationMs, result, nodeType) => {
        const neId = `${id}-${nodeId}`
        dao.updateNodeExecution(neId, {
          status,
          completed_at: new Date().toISOString(), duration: durationMs,
          ...(result?.sessionId ? { session_id: result.sessionId } : {}),
          ...(status === "completed" ? { error: null } : {}),
          ...(result?.outputs ? { outputs: JSON.stringify(result.outputs) } : {}),
        })
        const inst = enginePool.get(id)
        const globalSid = inst?.engine.getGlobalSessionId()
        if (globalSid) dao.updateExecution(id, { global_session_id: globalSid })

        if (result?.modelUsages && result.modelUsages.length > 0) {
          const now = new Date().toISOString()
          for (const mu of result.modelUsages) {
            dao.insertNodeTokenUsage(
              `${neId}-token-${mu.model}`, neId, mu.model,
              mu.inputTokens, mu.outputTokens, mu.costUsd ?? null,
              mu.cacheReadInputTokens ?? 0, mu.cacheCreationInputTokens ?? 0, now,
            )
          }
        }

        if (status === "pending_approval" && result?.approvalMetadata) {
          dao.updateExecution(id, { approval_metadata: JSON.stringify(result.approvalMetadata) })
          sse.emit(wsId, {
            event: "execution_pending_approval",
            data: { executionId: id, nodeId, approval: result.approvalMetadata },
          })
        }

        if (status === "pending_interaction" && result?.interactionMetadata) {
          dao.updateExecution(id, { interaction_metadata: JSON.stringify(result.interactionMetadata) })
        }

        const finalInput = result?.tokens?.input ?? 0
        const finalOutput = result?.tokens?.output ?? 0
        const hasTokens = finalInput > 0 || finalOutput > 0

        obs.flushNode(neId)

        const llmCalls = result?.llmCalls ?? []
        const modelUsages = result?.modelUsages ?? []
        // Compute cost from llmCalls (agent) or modelUsages (swarm/dispatch)
        const costUsd = llmCalls.length > 0
          ? llmCalls.reduce((sum: number, c: any) => sum + (c.costUsd ?? 0), 0)
          : modelUsages.reduce((sum: number, mu: any) => sum + (mu.costUsd ?? 0), 0)
        const turnCount = new Set(llmCalls.map((c: any) => c.turnIndex ?? 1)).size
        const toolCount = new Set(llmCalls.filter((c: any) => c.stopReason === "tool_use").map((c: any) => c.toolName)).size

        if (getFlag("llm_calls_persist") && result?.llmCalls && result.llmCalls.length > 0) {
          try {
            const exec = dao.findById(id)
            const calls = result.llmCalls.map((call: any, i: number) => ({ ...call, turnIndex: call.turnIndex || 1 }))
            obs.persistLLMCalls(neId, id, calls, exec?.instance_id ?? `inst-${process.env.PORT ?? "3001"}-${exec?.branch ?? "main"}`)
          } catch { /* silent */ }
        }

        sse.emit(wsId, {
          event: "node_end",
          data: {
            executionId: id, nodeId, status, durationMs, executorType: nodeType,
            costUsd: costUsd > 0 ? costUsd : undefined,
            turnCount: turnCount > 0 ? turnCount : undefined,
            toolCount: toolCount > 0 ? toolCount : undefined,
            ...(hasTokens ? { tokens: { input: finalInput, output: finalOutput } } : {}),
            ...(result?.modelUsages?.length ? {
              tokenUsages: result.modelUsages.map((mu: any) => ({
                model: mu.model,
                inputTokens: mu.inputTokens,
                outputTokens: mu.outputTokens,
                cacheReadTokens: mu.cacheReadInputTokens ?? 0,
                cacheCreationTokens: mu.cacheCreationInputTokens ?? 0,
              })),
            } : {}),
          },
        })

        // ── execution_metrics SSE: aggregate llm_calls + budget progress ──
        // Throttled to max 1 emit per 500ms (KD-6 / R1)
        scheduleMetricsEmit()

        this.syncStateJson()
      },

      onNodeLog: (nodeId, logLine) => {
        sse.emit(wsId, { event: "node_log", data: { executionId: id, nodeId, logLine } })
        // Persist logs that bypass the JSONL logger → compact → persist pipeline:
        // - Virtual nodes (e.g. __engine_init__)
        // - Sub-workflow child nodes (scoped IDs like "run-child:print-result")
        const isVirtualNode = nodeId.startsWith("__")
        const isSubWorkflowChild = nodeId.includes(":")
        if (isVirtualNode || isSubWorkflowChild) {
          try {
            const neId = `${id}-${nodeId}`
            dao.insertAgentEvent({
              node_execution_id: neId,
              event_order: Date.now(),
              turn_index: 0,
              event_type: "bash_log",
              timestamp: Date.now(),
              content: logLine,
              content_length: logLine.length,
              tool_call_id: null,
              tool_name: null,
              tool_input: null,
              tool_result: null,
              tool_is_error: 0,
              tool_duration_ms: null,
              status_value: null,
              error_code: null,
              error_message: null,
            })
          } catch { /* best-effort persistence */ }
        }
      },

      onNodeCompacted: (nodeId, mergedEvents) => {
        try { dao.replaceMergedEvents(id, nodeId, mergedEvents) } catch { /* non-fatal */ }
      },

      onStatusChange: (status, progress) => {
        dao.updateExecutionProgress(id, progress)
        sse.emit(wsId, { event: "execution_progress", data: { executionId: id, progress } })
        this.syncStateJson()
      },

      onError: (nodeId, error) => {
        dao.updateNodeExecution(`${id}-${nodeId}`, { status: "failed", error })
        sse.emit(wsId, { event: "error", data: { executionId: id, nodeId, error } })
        this.syncStateJson()
      },

      onComplete: () => {
        const ext = this.externalCallbacks.get(id) ?? this.externalCallbacks.get("__default__")
        if (ext?.onComplete) {
          try { ext.onComplete() } catch (err) {
            console.error("[EngineCallbacks] External onComplete failed:", err)
          }
          this.externalCallbacks.delete(id)
        }
      },

      onBranchStart: (neId, iteration) => {
        branchStartTimes.set(neId, Date.now())
        sse.emit(wsId, { event: "branch_start", data: { executionId: id, nodeExecutionId: neId, iteration } })
      },

      onBranchEnd: (neId, iteration, status, nodeResults) => {
        const startMs = branchStartTimes.get(neId)
        const durationMs = startMs ? Date.now() - startMs : undefined
        branchStartTimes.delete(neId)
        sse.emit(wsId, { event: "branch_end", data: { executionId: id, nodeExecutionId: neId, iteration, status, durationMs, nodeResults } })
      },

      onAgentEvent: (nodeId, event) => {
        sse.emit(wsId, { event: "agent_event", data: { executionId: id, nodeId, event } })

        // ── Heartbeat Observation: emit dedicated SSE events ────────────────
        if (event.type === "heartbeat") {
          sse.emit(wsId, {
            event: "agent_heartbeat",
            data: {
              executionId: id,
              nodeId,
              agent_name: (event.data as any).agent_name,
              version: (event.data as any).version,
              heartbeat: event.data,
            },
          })
          // Persist heartbeat to JSONL alongside agent events
          try {
            const logDir = join(this.ctx.workspacePath, "logs", id)
            if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
            const line = JSON.stringify({
              timestamp: new Date().toISOString(),
              node_id: nodeId,
              step: (event.data as any).step,
              tokens_used: (event.data as any).tokens_used,
              tokens_budget: (event.data as any).tokens_budget,
              artifacts: (event.data as any).artifacts ?? [],
              issues: (event.data as any).issues ?? [],
              confidence: (event.data as any).confidence ?? -1,
              current_activity: (event.data as any).current_activity,
            })
            appendFileSync(join(logDir, "heartbeats.jsonl"), line + "\n")
          } catch { /* best-effort JSONL persistence */ }
        }

        if (event.type === "heartbeat_stall") {
          sse.emit(wsId, {
            event: "heartbeat_stall",
            data: { executionId: id, nodeId },
          })
        }

        if (event.type === "harness_directive") {
          sse.emit(wsId, {
            event: "harness_directive",
            data: {
              executionId: id,
              nodeId,
              directive: event.data,
            },
          })
        }

        if (getFlag("agent_events_persist")) {
          try {
            const neId = `${id}-${nodeId}`
            const exec = dao.findById(id)
            obs.bufferEvent(neId, event, {
              executionId: id, nodeId, org: this.org,
              workspaceId: this.workspaceDbId, workflowRef: exec?.workflow_ref ?? "unknown",
            })
          } catch { /* silent */ }
        }
      },

      onSwarmEvent: (nodeId, event) => {
        sse.emit(wsId, {
          event: event.type,
          data: { executionId: id, nodeId, ...(event.data ?? {}) },
        })
        try {
          const neId = `${id}-${nodeId}`
          dao.insertAgentEvent({
            node_execution_id: neId,
            event_order: Date.now(),
            turn_index: 0,
            event_type: event.type,
            timestamp: Date.now(),
            content: JSON.stringify(event.data ?? {}),
            content_length: JSON.stringify(event.data ?? {}).length,
            tool_call_id: null,
            tool_name: null,
            tool_input: null,
            tool_result: null,
            tool_is_error: 0,
            tool_duration_ms: null,
            status_value: null,
            error_code: null,
            error_message: null,
          })
        } catch { /* silent — swarm event persistence is best-effort */ }
      },

      onNodeRetry: (nodeId: string, attempt: number, maxAttempts: number, delayMs: number) => {
        dao.updateNodeRetryInfo(id, nodeId, attempt, new Date().toISOString())
        sse.emit(wsId, {
          event: "node_retry", data: { executionId: id, nodeId, attempt, maxAttempts, delayMs },
        })
      },

      onPipelineReloaded: (config: PipelineConfig) => {
        sse.emit(wsId, { event: "pipeline_reloaded", data: { executionId: id, config } })
      },

      onRuntimeNodeAdded: (nodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => {
        const neId = `${id}-${nodeId}`
        dao.insertNodeExecutionOrIgnore({
          id: neId, execution_id: id, node_id: nodeId, node_type: nodeType,
          status: "pending", started_at: new Date().toISOString(),
          parent_node_id: meta?.parentNodeId ?? null,
          iteration_index: meta?.iterationIndex ?? null,
        })
        sse.emit(wsId, { event: "runtime_node_added", data: { executionId: id, nodeId, nodeType, parentNodeId: meta?.parentNodeId, iterationIndex: meta?.iterationIndex } })
      },
    }
  }
}
