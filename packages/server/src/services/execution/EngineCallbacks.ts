// packages/server/src/services/execution/EngineCallbacks.ts
//
// Full-featured engine callbacks — mirrors the behavior previously inline in
// ExecutionLifecycle.buildCallbacks(). Handles SSE emission, DB persistence,
// observability integration, token tracking, and external callback dispatch.
//
import { totalTokens, costSummary } from "@octopus/shared"
import type { IEngineCallbacks } from "./interfaces"
import type { ServiceContext } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import type { EngineCallbacks as EngineCallbackType } from "@octopus/engine"
import type { PipelineConfig, HookDef, NotifyProviderConfig, ChannelProfile } from "@octopus/shared"
import type { EnginePool } from "./EnginePool"
import type { ObservabilityService } from "../observability"
import { getFlag } from "../../config/feature-flags"
import { appendFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { NotifyDispatcher, ProviderRegistry, registerBuiltinProviders } from "@octopus/engine"
import { VarPool, TemplateRenderer } from "@octopus/shared"

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

    // Budget hook guards — prevent repeated dispatch
    let budgetWarningSent = false
    let budgetExceededSent = false

    /**
     * Dispatch budget hook events (on_budget_warning / on_budget_exceeded).
     * Reads workflow definition to get notify hooks, providers, channels.
     * Dispatches notify-type hooks via NotifyDispatcher.
     * Emits SSE event for frontend.
     */
    const dispatchBudgetHook = async (
      event: "on_budget_warning" | "on_budget_exceeded",
      context: Record<string, string>,
    ) => {
      // Emit SSE for frontend
      sse.emit(wsId, {
        event: "budget_warning",
        data: {
          executionId: id,
          hookEvent: event,
          ...context,
        },
      })

      // Load workflow definition to get hooks/providers/channels
      try {
        const exec = dao.findById(id)
        if (!exec?.workflow_ref) return

        const wfDetail = this.ctx.workflowService.get(
          this.ctx.workspacePath,
          exec.workflow_ref,
          id,
        )
        if (!wfDetail?.parsed) return

        const wf = wfDetail.parsed
        const hooks = wf.hooks?.[event] as HookDef[] | undefined
        if (!hooks || hooks.length === 0) return

        const providers = wf.providers ?? {}
        const channels = wf.channels ?? {}

        // Build VarPool with hook context
        const pool = new VarPool({})
        if (exec.var_pool) {
          try {
            const snapshot = JSON.parse(exec.var_pool)
            pool.update(snapshot)
          } catch { /* use empty pool */ }
        }
        pool.update({
          "hook.event": event.replace("on_", ""),
          "hook.workflow_name": wf.name,
          "hook.execution_id": id,
          "hook.timestamp": new Date().toISOString(),
          ...Object.fromEntries(Object.entries(context).map(([k, v]) => [`hook.${k}`, v])),
        })

        // Dispatch notify-type hooks
        registerBuiltinProviders()
        const dispatcher = new NotifyDispatcher(
          new ProviderRegistry(),
          new TemplateRenderer(),
        )

        for (const hook of hooks) {
          if (hook.type !== "notify") continue
          try {
            const results = await dispatcher.dispatch({
              hook,
              pool,
              providers: providers as Record<string, NotifyProviderConfig>,
              channels: channels as Record<string, ChannelProfile>,
            })
            for (const r of results) {
              if (!r.success) {
                console.warn(`[EngineCallbacks] Budget notify failed: ${r.error}`)
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(`[EngineCallbacks] Budget hook ${event} error: ${msg}`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[EngineCallbacks] dispatchBudgetHook error: ${msg}`)
      }
    }

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
          let budgetSnapshot: { max_tokens?: number; max_duration?: number; max_cost_usd?: number; alert_threshold?: number; token_counting_mode?: string } | null = null
          if (exec?.budget_snapshot) {
            try { budgetSnapshot = JSON.parse(exec.budget_snapshot) } catch { /* ignore */ }
          }

          // Compute budget progress — respect token_counting_mode
          const mode = budgetSnapshot?.token_counting_mode ?? "all"
          const consumedTokens = mode === "no_cache"
            ? metrics.usage.inputTokens + metrics.usage.outputTokens
            : totalTokens(metrics.usage)
          const budgetProgress: {
            tokensPercent: number | null
            durationPercent: number | null
            costPercent: number | null
          } = { tokensPercent: null, durationPercent: null, costPercent: null }

          if (budgetSnapshot) {
            if (budgetSnapshot.max_tokens) {
              budgetProgress.tokensPercent = (consumedTokens / budgetSnapshot.max_tokens) * 100
            }
            if (budgetSnapshot.max_cost_usd) {
              budgetProgress.costPercent = metrics.totals.cost.usd === null
                ? null // 未定价：费用预算进度不可计算（不假 0%）
                : (metrics.totals.cost.usd / budgetSnapshot.max_cost_usd) * 100
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
              // C1：嵌套规范 usage（不再平铺 totalInputTokens 等 5 字段）
              usage: metrics.usage,
              // C3: 唯一 totals（tokens=四字段和 / cost 三态 / cacheHitRate 0–1）
              totals: metrics.totals,
              totalLlmTurns: metrics.totalLlmTurns,
              budgetProgress,
              errorCount: metrics.errorCount,
              timestamp: new Date().toISOString(),
            },
          })

          // Budget warning: totalTokens > max_tokens * alert_threshold
          if (budgetSnapshot?.max_tokens && !budgetWarningSent) {
            const threshold = budgetSnapshot.alert_threshold ?? 0.8
            const warningLimit = budgetSnapshot.max_tokens * threshold
            if (consumedTokens > warningLimit && consumedTokens <= budgetSnapshot.max_tokens) {
              budgetWarningSent = true
              const pct = (consumedTokens / budgetSnapshot.max_tokens * 100).toFixed(1)
              console.warn(
                `[EngineCallbacks] Budget warning: execution ${id} has consumed ${consumedTokens}/${budgetSnapshot.max_tokens} tokens (${pct}%, threshold ${threshold * 100}%)`,
              )
              // Dispatch on_budget_warning hooks + SSE
              dispatchBudgetHook("on_budget_warning", {
                total_tokens: String(consumedTokens),
                max_tokens: String(budgetSnapshot.max_tokens),
                tokens_percent: pct,
                alert_threshold: String(threshold),
                execution_id: id,
                workflow_name: exec?.workflow_name ?? "unknown",
              })
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

          let budgetSnapshot: { max_tokens?: number; alert_threshold?: number; token_counting_mode?: string }
          try { budgetSnapshot = JSON.parse(exec.budget_snapshot) } catch { return { action: "proceed" as const } }

          if (!budgetSnapshot.max_tokens) return { action: "proceed" as const }

          const metrics = tokenUsageDao.aggregateByExecution(id)
          const mode = budgetSnapshot.token_counting_mode ?? "all"
          const consumedTokens = mode === "no_cache"
            ? metrics.usage.inputTokens + metrics.usage.outputTokens
            : totalTokens(metrics.usage)

          if (consumedTokens > budgetSnapshot.max_tokens) {
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
                budgetSnapshot: { max_tokens: budgetSnapshot.max_tokens, actual: consumedTokens },
              },
            })
            // Emit execution_progress to notify external listeners (dashboard, etc.)
            sse.emit(wsId, {
              event: "execution_progress",
              data: { executionId: id, status: "budget_exceeded", completedAt: now },
            })
            // Dispatch on_budget_exceeded hooks + SSE
            if (!budgetExceededSent) {
              budgetExceededSent = true
              const pct = (consumedTokens / budgetSnapshot.max_tokens * 100).toFixed(1)
              dispatchBudgetHook("on_budget_exceeded", {
                total_tokens: String(consumedTokens),
                max_tokens: String(budgetSnapshot.max_tokens),
                tokens_percent: pct,
                alert_threshold: String(budgetSnapshot.alert_threshold ?? 0.8),
                execution_id: id,
                workflow_name: exec?.workflow_name ?? "unknown",
              })
            }
            // Abort the engine so subsequent nodes don't run
            enginePool.cancel(id)

            return {
              action: "override" as const,
              overrideResult: {
                outputs: { error: "Budget exceeded" },
                status: "failed" as const,
                durationMs: 0,
                logLines: [`Budget exceeded: ${consumedTokens}/${budgetSnapshot.max_tokens} tokens consumed`],
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

      onOutputsUpdate: (nodeId, outputs) => {
        // Mid-execution outputs (e.g. dynamic_sub_workflow generated_workflow,
        // persisted when the DAG is generated — before node_end) so consumers can
        // render the child workflow while the node is still running.
        const neId = `${id}-${nodeId}`
        try {
          dao.updateNodeExecution(neId, { outputs: JSON.stringify(outputs) })
        } catch { /* non-fatal: node row may not exist yet */ }
        sse.emit(wsId, {
          event: "node_outputs_update",
          data: { executionId: id, nodeId, outputs },
        })
      },

      onNodeEnd: (nodeId, status, durationMs, result, nodeType) => {
        const neId = `${id}-${nodeId}`
        const isFailed = ["failed", "skipped_failed", "error"].includes(status)
        const nodeError = isFailed
          ? (result?.logLines?.join("\n") ?? result?.error ?? null)
          : (status === "completed" ? null : undefined)
        dao.updateNodeExecution(neId, {
          status,
          completed_at: new Date().toISOString(), duration: durationMs,
          ...(result?.sessionId ? { session_id: result.sessionId } : {}),
          ...(nodeError !== undefined ? { error: nodeError } : {}),
          ...(result?.outputs ? { outputs: JSON.stringify(result.outputs) } : {}),
        })
        const inst = enginePool.get(id)
        const globalSid = inst?.engine.getGlobalSessionId()
        if (globalSid) dao.updateExecution(id, { global_session_id: globalSid })

        if (result?.modelUsages && result.modelUsages.length > 0) {
          const now = new Date().toISOString()
          for (const mu of result.modelUsages) {
            // C3: ledger 唯一写入口（cost 兜底估算也在入口内，与 llm_calls 对称）
            tokenUsageDao.recordNodeUsage({
              id: `${neId}-token-${mu.model}`,
              nodeExecutionId: neId,
              model: mu.model,
              usage: mu,
              costUsd: mu.costUsd,
              source: 'node',
              createdAt: now,
            })
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

        const nodeUsage = result?.usage
        const hasTokens = !!nodeUsage && totalTokens(nodeUsage) > 0

        obs.flushNode(neId)

        const llmCalls = result?.llmCalls ?? []
        const modelUsages = result?.modelUsages ?? []
        // C3: 节点 cost 走 ledger 三态（全未定价 = null，不再 ??0 焊成假 $0）
        const costUsd = costSummary(
          (llmCalls.length > 0 ? llmCalls : modelUsages).map((c: any) => c.costUsd as number | null | undefined),
        ).usd
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
            costUsd: costUsd ?? undefined,
            turnCount: turnCount > 0 ? turnCount : undefined,
            toolCount: toolCount > 0 ? toolCount : undefined,
            ...(hasTokens ? { usage: nodeUsage } : {}),
            ...(result?.modelUsages?.length ? { modelUsages: result.modelUsages } : {}),
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

      // goal-task-dev T6 fix: engine.ts:431 fires onComplete INSIDE run(), before
      // the server persists the final status (run() returns later) — the external
      // consumer must receive the engine's authoritative value instead of
      // re-reading a still-'running' DB row.
      onComplete: (finalStatus?: string) => {
        const ext = this.externalCallbacks.get(id) ?? this.externalCallbacks.get("__default__")
        if (ext?.onComplete) {
          try { ext.onComplete(finalStatus ?? '') } catch (err) {
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

        // ── Intervention Result: persist to agent_events + dedicated SSE ──
        if (event.type === "intervention_result") {
          const data = event.data as Record<string, unknown> | undefined
          const resultText = typeof data?.result === "string" ? data.result : JSON.stringify(data ?? {})
          sse.emit(wsId, {
            event: "intervention_result",
            data: { executionId: id, nodeId, result: resultText, sessionId: data?.sessionId },
          })
          try {
            const neId = `${id}-${nodeId}`
            dao.insertAgentEvent({
              node_execution_id: neId,
              event_order: Date.now(),
              turn_index: 0,
              event_type: "intervention_result",
              timestamp: Date.now(),
              content: resultText,
              content_length: resultText.length,
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
          } catch { /* silent — intervention result persistence is best-effort */ }
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
