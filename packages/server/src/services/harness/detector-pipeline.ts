// packages/server/src/services/harness/detector-pipeline.ts
//
// DetectorPipeline — Layer 1 of the Harness.
// Creates per-execution detector instances and wraps EngineCallbacks with a Proxy
// to intercept relevant events and route them to detectors.
// When a detector produces a DiagnosisReport, it is persisted to harness_events
// and emitted as an SSE event.

import type { DiagnosisReport, HarnessSystemConfigParsed } from "@octopus/shared"
import type { HarnessEvent, StrategyAction } from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { BaseDetector } from "./base-detector"
import type { HarnessCallbackEvent } from "./base-detector"
import { StupidRetryDetector } from "./detectors/stupid-retry"
import { ModelMismatchDetector } from "./detectors/model-mismatch"
import { ProcessConflictDetector } from "./detectors/process-conflict"
import { TimeoutCascadeDetector } from "./detectors/timeout-cascade"
import type { StrategyEngine } from "./strategy-engine"
import type { EngineCallbacks } from "@octopus/engine"

/**
 * Pending retry decision stored by nodeId.
 * Consumed (deleted) on the next onBeforeRetry invocation for that node.
 */
export interface PendingRetryAction {
  harnessHint?: string
  modelOverride?: string
  action: "retry" | "skip" | "abort" | "override"
  overrideResult?: any
}

/**
 * Pending failure decision stored by nodeId.
 * Consumed (deleted) on the next onFailureDecision invocation for that node.
 */
export interface PendingFailureAction {
  action: "continue" | "abort" | "delegate"
}

/**
 * Pending block decision stored by nodeId.
 * Used by onBeforeNode to synchronously block dangerous nodes (BP-5).
 */
export interface PendingBlockAction {
  action: "skip"
  overrideResult: {
    status: "failed"
    error: string
  }
}

/**
 * Preference-to-model resolution map for switch_model actions.
 * Mirrors the logic in actions/switch-model.ts for synchronous extraction.
 */
const PREFERENCE_MODELS: Record<string, string> = {
  vision_capable: "claude-sonnet-4-20250514",
  tool_capable: "claude-sonnet-4-20250514",
  default: "claude-sonnet-4-20250514",
}

export interface DetectorPipelineDeps {
  config: HarnessSystemConfigParsed
  executionId: string
  workspaceId: string
  dao: HarnessDAO
  sse: SSEService
  hostPid?: string
  hostPorts?: string[]
  strategyEngine?: StrategyEngine
}

export class DetectorPipeline {
  private detectors: BaseDetector[] = []
  private executionId: string
  private workspaceId: string
  private dao: HarnessDAO
  private sse: SSEService
  private strategyEngine?: StrategyEngine

  /**
   * Pending retry decisions keyed by nodeId.
   * Populated by StrategyEngine results; consumed by onBeforeRetry proxy.
   */
  private pendingActions = new Map<string, PendingRetryAction>()

  /**
   * Pending failure decisions keyed by nodeId.
   * Populated by StrategyEngine results; consumed by onFailureDecision proxy.
   */
  private pendingFailureActions = new Map<string, PendingFailureAction>()

  /**
   * Pending block decisions keyed by nodeId (BP-5).
   * Populated synchronously when a CRITICAL report matches an abort strategy;
   * consumed by onBeforeNode proxy to prevent dangerous node execution.
   */
  private pendingBlockActions = new Map<string, PendingBlockAction>()

  constructor(deps: DetectorPipelineDeps) {
    this.executionId = deps.executionId
    this.workspaceId = deps.workspaceId
    this.dao = deps.dao
    this.sse = deps.sse
    this.strategyEngine = deps.strategyEngine

    this.detectors = this.createDetectors(deps.config, deps.hostPid, deps.hostPorts)
  }

  /**
   * Set or replace the StrategyEngine for this pipeline.
   * Called by HarnessController when integrating Layer 2.
   */
  setStrategyEngine(engine: StrategyEngine): void {
    this.strategyEngine = engine
  }

  /**
   * Number of active detectors (for testing).
   */
  get detectorCount(): number {
    return this.detectors.length
  }

  /**
   * Create detector instances based on config.
   */
  private createDetectors(
    config: HarnessSystemConfigParsed,
    hostPid?: string,
    hostPorts?: string[],
  ): BaseDetector[] {
    const detectors: BaseDetector[] = []
    const d = config.detectors

    if (d.stupid_retry?.enabled) {
      detectors.push(
        new StupidRetryDetector({
          threshold: d.stupid_retry.threshold ?? 2,
        }),
      )
    }

    if (d.model_mismatch?.enabled) {
      detectors.push(new ModelMismatchDetector())
    }

    if (d.process_conflict?.enabled) {
      detectors.push(
        new ProcessConflictDetector({
          hostPid: hostPid ?? String(process.pid),
          hostPorts: hostPorts ?? [],
        }),
      )
    }

    if (d.timeout_cascade?.enabled) {
      detectors.push(
        new TimeoutCascadeDetector({
          threshold: d.timeout_cascade.threshold ?? 3,
        }),
      )
    }

    return detectors
  }

  /**
   * Route an event to all detectors and handle any DiagnosisReports.
   * Returns the list of reports produced (for synchronous post-processing).
   */
  routeEvent(event: HarnessCallbackEvent): DiagnosisReport[] {
    const reports: DiagnosisReport[] = []
    for (const detector of this.detectors) {
      try {
        const report = detector.observe(event)
        if (report) {
          // Fill in executionId if not set
          if (!report.executionId) {
            report.executionId = this.executionId
          }
          reports.push(report)
          this.handleDiagnosis(report)
        }
      } catch (err) {
        console.error(
          `[DetectorPipeline] Error in detector ${detector.name}:`,
          err,
        )
      }
    }
    return reports
  }

  /**
   * Persist a DiagnosisReport to harness_events and emit SSE.
   * Then route the report to the StrategyEngine (Layer 2) if available.
   */
  private handleDiagnosis(report: DiagnosisReport): void {
    // Persist to DB
    const row: HarnessEvent = {
      id: report.id,
      execution_id: report.executionId,
      node_id: report.nodeId,
      timestamp: report.timestamp,
      event_type: "diagnosis",
      detector: report.detector,
      severity: report.severity,
      report_json: JSON.stringify(report),
      action_json: null,
      result_json: null,
      token_usage_json: null,
      created_at: Math.floor(Date.now() / 1000),
    }

    try {
      this.dao.insertEvent(row)
    } catch (err) {
      console.error("[DetectorPipeline] Failed to persist harness event:", err)
    }

    // Emit SSE
    try {
      this.sse.emit(this.workspaceId, {
        event: "harness_diagnosis",
        data: {
          executionId: report.executionId,
          report,
        },
      })
    } catch (err) {
      console.error("[DetectorPipeline] Failed to emit SSE event:", err)
    }

    // Route to StrategyEngine (Layer 2) if available
    if (this.strategyEngine) {
      this.strategyEngine.handleReport(report).then((result) => {
        // Store intervention results as pending decisions for the engine to consume
        const nodeId = report.nodeId
        for (const actionResult of result.actionResults) {
          if (actionResult.success && (actionResult.harnessHint || actionResult.modelOverride)) {
            this.pendingActions.set(nodeId, {
              action: "retry",
              harnessHint: actionResult.harnessHint,
              modelOverride: actionResult.modelOverride,
            })
          }
        }

        // If delegation is requested, store a failure decision
        if (result.delegate) {
          this.pendingFailureActions.set(nodeId, { action: "delegate" })
        }
      }).catch((err) => {
        console.error("[DetectorPipeline] StrategyEngine error:", err)
      })
    }
  }

  /**
   * Synchronously extract harnessHint/modelOverride from a DiagnosisReport
   * by matching the strategy and inspecting action definitions (BP-2).
   * This runs synchronously so that pendingActions is populated BEFORE
   * the next onBeforeRetry call from the engine.
   *
   * Also checks for CRITICAL reports with abort strategies and stores
   * a block action for onBeforeNode (BP-5).
   */
  synchronouslyStorePendingAction(report: DiagnosisReport): void {
    if (!this.strategyEngine) return

    const matchedStrategy = this.strategyEngine.matchStrategy(report)
    if (!matchedStrategy) return

    const nodeId = report.nodeId

    // BP-5: CRITICAL report + abort action → store block decision for onBeforeNode
    if (report.severity === "critical") {
      const hasAbort = matchedStrategy.actions.some(
        (a: StrategyAction) => a.type === "abort",
      )
      if (hasAbort) {
        this.pendingBlockActions.set(nodeId, {
          action: "skip",
          overrideResult: {
            status: "failed",
            error: "Blocked by harness: process conflict",
          },
        })
      }
    }

    // BP-2: Extract harnessHint/modelOverride synchronously from action definitions
    let harnessHint: string | undefined
    let modelOverride: string | undefined

    for (const action of matchedStrategy.actions) {
      if (action.type === "retry_with_hint") {
        harnessHint =
          (action.message as string) ??
          (action.hint as string) ??
          "Try a different approach to solve this problem."
      }
      if (action.type === "switch_model") {
        const explicitModel = action.model as string | undefined
        const prefer = action.prefer as string | undefined
        if (explicitModel) {
          modelOverride = explicitModel
        } else if (prefer) {
          modelOverride = PREFERENCE_MODELS[prefer] ?? PREFERENCE_MODELS.default
        } else {
          modelOverride = PREFERENCE_MODELS.default
        }
      }
    }

    if (harnessHint || modelOverride) {
      this.pendingActions.set(nodeId, {
        action: "retry",
        harnessHint,
        modelOverride,
      })
    }

    // Store delegate decision synchronously if applicable
    if (matchedStrategy.delegate_to_agent === true) {
      this.pendingFailureActions.set(nodeId, { action: "delegate" })
    }
  }

  /**
   * Wrap EngineCallbacks with a Proxy that intercepts relevant callbacks,
   * routes events to detectors, and then calls the original callback.
   *
   * Non-intercepted callbacks pass through untouched.
   */
  wrapCallbacks(callbacks: EngineCallbacks): EngineCallbacks {
    const pipeline = this

    return new Proxy(callbacks, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver)

        // ── Decision callbacks: always intercept (even if target lacks them) ──
        // These are the harness's write-back channel to the engine.
        // The Proxy synthesises a handler when the target does not provide one,
        // so that pending StrategyEngine decisions can still be delivered.

        if (prop === "onBeforeRetry") {
          return async function (
            nodeId: string,
            attempt: number,
            lastResult: any,
          ) {
            const pending = pipeline.pendingActions.get(nodeId)
            if (pending) {
              pipeline.pendingActions.delete(nodeId)
              return pending
            }
            if (typeof original === "function") {
              return original.call(target, nodeId, attempt, lastResult)
            }
            return { action: "retry" }
          }
        }

        if (prop === "onFailureDecision") {
          return async function (
            nodeId: string,
            error: string,
            currentStrategy: string,
          ) {
            const pending = pipeline.pendingFailureActions.get(nodeId)
            if (pending) {
              pipeline.pendingFailureActions.delete(nodeId)
              return pending
            }
            if (typeof original === "function") {
              return original.call(target, nodeId, error, currentStrategy)
            }
            return { action: "continue" }
          }
        }

        // ── onBeforeNode: always intercept (even if target lacks it) ──
        // The ProcessConflictDetector needs beforeNode events for static
        // script scanning. buildCallbacks() does NOT provide onBeforeNode,
        // so the Proxy must synthesise one to route events to detectors.
        if (prop === "onBeforeNode") {
          return async function (
            nodeId: string,
            nodeType: string,
            nodeConfig: any,
          ) {
            const reports = pipeline.routeEvent({
              type: "beforeNode",
              nodeId,
              nodeType,
              nodeConfig,
            })
            // BP-5: Synchronously check for CRITICAL reports with abort strategies.
            for (const report of reports) {
              pipeline.synchronouslyStorePendingAction(report)
            }
            const blockAction = pipeline.pendingBlockActions.get(nodeId)
            if (blockAction) {
              pipeline.pendingBlockActions.delete(nodeId)
              return blockAction
            }
            if (typeof original === "function") {
              return original.call(target, nodeId, nodeType, nodeConfig)
            }
            return { action: "proceed" as const }
          }
        }

        // ── Observation callbacks: only intercept when target provides them ──
        if (typeof original !== "function") return original

        switch (prop) {
          case "onNodeStart":
            return function (nodeId: string, nodeType: string) {
              pipeline.routeEvent({ type: "nodeStart", nodeId, nodeType })
              return original.call(target, nodeId, nodeType)
            }

          case "onNodeEnd":
            return function (
              nodeId: string,
              status: string,
              durationMs: number,
              result?: any,
              nodeType?: string,
            ) {
              pipeline.routeEvent({
                type: "nodeEnd",
                nodeId,
                status,
                durationMs,
                result,
                nodeType,
              })
              // BP-10: Clean up ALL pending decisions to prevent memory leaks
              pipeline.pendingActions.delete(nodeId)
              pipeline.pendingFailureActions.delete(nodeId)
              pipeline.pendingBlockActions.delete(nodeId)
              return original.call(target, nodeId, status, durationMs, result, nodeType)
            }

          case "onNodeRetry":
            return function (
              nodeId: string,
              attempt: number,
              maxAttempts: number,
              delayMs: number,
              result?: any,
            ) {
              const reports = pipeline.routeEvent({
                type: "nodeRetry",
                nodeId,
                attempt,
                maxAttempts,
                delayMs,
                result,
              })
              // BP-2: Synchronously populate pendingActions from diagnosis reports.
              // This ensures that by the next onBeforeRetry call (for attempt+1),
              // the pending action is already stored.
              for (const report of reports) {
                pipeline.synchronouslyStorePendingAction(report)
              }
              return original.call(target, nodeId, attempt, maxAttempts, delayMs)
            }

          case "onAgentEvent":
            return function (nodeId: string, event: any) {
              pipeline.routeEvent({ type: "agentEvent", nodeId, event })
              return original.call(target, nodeId, event)
            }

          case "onError":
            return function (nodeId: string, error: string) {
              pipeline.routeEvent({ type: "error", nodeId, error })
              return original.call(target, nodeId, error)
            }

          default:
            return original
        }
      },
    })
  }

  /**
   * Destroy all detectors and release resources.
   */
  destroy(): void {
    for (const detector of this.detectors) {
      try {
        detector.destroy()
      } catch (err) {
        console.error(
          `[DetectorPipeline] Error destroying detector ${detector.name}:`,
          err,
        )
      }
    }
    this.detectors = []
  }
}
