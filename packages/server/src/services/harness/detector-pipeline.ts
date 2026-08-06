// packages/server/src/services/harness/detector-pipeline.ts
//
// DetectorPipeline — Layer 1 of the Harness.
// Creates per-execution detector instances and wraps EngineCallbacks with a Proxy
// to intercept relevant events and route them to detectors.
// When a detector produces a DiagnosisReport, it is persisted to harness_events
// and emitted as an SSE event.

import type { DiagnosisReport, HarnessSystemConfigParsed, DelegationResult, HarnessDecisionType } from "@octopus/shared"
import type { HarnessEvent, StrategyAction } from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { BaseDetector } from "./base-detector"
import type { HarnessCallbackEvent } from "./base-detector"
import { StupidRetryDetector } from "./detectors/stupid-retry"
import { ModelMismatchDetector } from "./detectors/model-mismatch"
import { ProcessConflictDetector } from "./detectors/process-conflict"
import { TimeoutCascadeDetector } from "./detectors/timeout-cascade"
import { DangerousPatternMatcher } from "./dangerous-pattern-matcher"
import type { StrategyEngine } from "./strategy-engine"
import type { EngineCallbacks } from "@octopus/engine"

/**
 * Pending retry decision stored by nodeId.
 * Consumed (deleted) on the next onBeforeRetry invocation for that node.
 */
export interface PendingRetryAction {
  harnessHint?: string
  modelOverride?: string
  varPoolPatches?: Record<string, string>
  action: "retry" | "skip" | "abort" | "override"
  overrideResult?: any
}

/**
 * Pending failure decision stored by nodeId.
 * Consumed (deleted) on the next onFailureDecision invocation for that node.
 */
export interface PendingFailureAction {
  action: "continue" | "abort" | "delegate" | "override"
  overrideResult?: any
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
  private hostPid: string = ""
  private hostPorts: string[] = []
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
    this.hostPid = deps.hostPid ?? String(process.pid)
    this.hostPorts = deps.hostPorts ?? []

    this.detectors = this.createDetectors(deps.config, this.hostPid, this.hostPorts)
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
  routeEvent(event: HarnessCallbackEvent, skipStrategy: boolean = false): DiagnosisReport[] {
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
          this.handleDiagnosis(report, skipStrategy)
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
  private handleDiagnosis(report: DiagnosisReport, skipStrategy: boolean = false): void {
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

    // Update node_executions.harness_status and insert agent_event for log viewer
    this.updateNodeHarnessStatus(report.nodeId, "harness_intervening", report)

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
    // skipStrategy = true when caller (onBeforeNode) handles delegation directly
    if (!skipStrategy && this.strategyEngine) {
      this.strategyEngine.handleReport(report).then((result) => {
        // If Layer 3 delegation occurred, process the structured decision
        if (result.delegationResult) {
          this.processDecision(report, result.delegationResult)
          return
        }

        // Fallback: store intervention results as pending decisions (legacy path)
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

        // If delegation is requested but no result yet, store a failure decision
        if (result.delegate && !result.delegationResult) {
          this.pendingFailureActions.set(nodeId, { action: "delegate" })
        }
      }).catch((err) => {
        console.error("[DetectorPipeline] StrategyEngine error:", err)
      })
    }
  }

  /**
   * Synchronously store a block action for process_conflict + critical reports (BP-5).
   * This runs synchronously so that pendingBlockActions is populated BEFORE
   * the onBeforeNode proxy returns, ensuring dangerous nodes are blocked immediately.
   *
   * Only process_conflict reports trigger synchronous blocking.
   * All other reports are routed asynchronously to the Harness Agent (Layer 3).
   */
  synchronouslyStorePendingAction(report: DiagnosisReport): void {
    if (!this.strategyEngine) return

    // BP-5: Only process_conflict + critical → synchronous block
    if (report.detector !== "process_conflict" || report.severity !== "critical") {
      return
    }

    const matchedStrategy = this.strategyEngine.matchStrategy(report)
    if (!matchedStrategy) return

    const nodeId = report.nodeId

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
      // Mark the node as harness_blocked in DB + insert agent_event
      this.updateNodeHarnessStatus(nodeId, "harness_blocked", report)
      // Update execution-level harness_status
      this.updateExecutionHarnessStatus("blocked")
    }
  }

  /**
   * Process a DelegationResult from the Harness Agent (Layer 3).
   * Maps the structured decision to the correct pending action, updates
   * node_executions.harness_status, executions.harness_status, and records
   * an agent_event with the decision field for log rendering.
   *
   * Decision mapping:
   * - fix_and_retry    → pendingActions with varPoolPatches + harnessHint
   * - guide_and_retry  → pendingActions with harnessHint
   * - reconfigure_and_retry → pendingActions with modelOverride
   * - agent_takeover   → pendingFailureAction: { action: "delegate" } + overrideResult to DB
   * - block_node       → pendingBlockAction (same as synchronous path)
   *
   * Node harness_status mapping:
   * - fix/guide/reconfigure → harness_modified
   * - agent_takeover        → harness_executed
   * - block_node            → harness_blocked
   *
   * Execution harness_status mapping:
   * - fix/guide/reconfigure → intervened
   * - agent_takeover        → delegated
   * - block_node            → blocked
   */
  processDecision(report: DiagnosisReport, result: DelegationResult): void {
    const nodeId = report.nodeId

    if (!result.success) {
      // Failed delegation: treat as block_node (safe default)
      this.updateNodeHarnessStatus(nodeId, "harness_blocked", report, {
        decision: result.decision,
        reasoning: result.reasoning,
      })
      this.updateExecutionHarnessStatus("blocked")
      return
    }

    switch (result.decision) {
      case "fix_and_retry":
        this.pendingActions.set(nodeId, {
          action: "retry",
          varPoolPatches: result.varPoolPatches,
          harnessHint: result.harnessHint,
        })
        this.updateNodeHarnessStatus(nodeId, "harness_modified", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          varPoolPatches: result.varPoolPatches,
          harnessHint: result.harnessHint,
        })
        this.updateExecutionHarnessStatus("intervened")
        break

      case "guide_and_retry":
        this.pendingActions.set(nodeId, {
          action: "retry",
          harnessHint: result.harnessHint,
        })
        this.updateNodeHarnessStatus(nodeId, "harness_modified", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          harnessHint: result.harnessHint,
        })
        this.updateExecutionHarnessStatus("intervened")
        break

      case "reconfigure_and_retry":
        this.pendingActions.set(nodeId, {
          action: "retry",
          modelOverride: result.modelOverride,
        })
        this.updateNodeHarnessStatus(nodeId, "harness_modified", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          modelOverride: result.modelOverride,
        })
        this.updateExecutionHarnessStatus("intervened")
        break

      case "agent_takeover":
        this.pendingFailureActions.set(nodeId, { action: "delegate" })
        // Write overrideResult to DB for the engine to pick up on resume
        this.writeOverrideResultToDb(nodeId, {
          status: "completed",
          outputs: result.takeoverOutput ? { output: result.takeoverOutput } : undefined,
          exitCode: result.takeoverExitCode ?? 0,
        })
        this.updateNodeHarnessStatus(nodeId, "harness_executed", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          takeoverOutput: result.takeoverOutput,
        })
        this.updateExecutionHarnessStatus("delegated")
        break

      case "block_node":
        this.pendingBlockActions.set(nodeId, {
          action: "skip",
          overrideResult: {
            status: "failed",
            error: result.blockReason ?? "Blocked by harness agent",
          },
        })
        this.updateNodeHarnessStatus(nodeId, "harness_blocked", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          blockReason: result.blockReason,
          continueSubsequent: result.continueSubsequent,
        })
        this.updateExecutionHarnessStatus("blocked")
        break
    }
  }

  /**
   * Write the override result from an agent_takeover to the node_executions table.
   * The engine reads this when resuming after a delegate pause.
   */
  private writeOverrideResultToDb(
    nodeId: string,
    overrideResult: { status: string; outputs?: Record<string, unknown>; exitCode?: number },
  ): void {
    try {
      const db = this.dao.getDb()
      const neId = `${this.executionId}-${nodeId}`
      db.prepare(
        `UPDATE node_executions SET override_result = ? WHERE id = ?`,
      ).run(JSON.stringify(overrideResult), neId)
    } catch (err) {
      console.error("[DetectorPipeline] Failed to write override_result to DB:", err)
    }
  }

  /**
   * Update executions.harness_status (execution-level).
   * Only escalates: intervened → blocked → delegated (never downgrades).
   *
   * Status hierarchy:
   * - NULL (no intervention)
   * - intervened (harness modified something but execution continued)
   * - blocked (a node was blocked)
   * - delegated (agent takeover occurred)
   */
  private updateExecutionHarnessStatus(status: "intervened" | "blocked" | "delegated"): void {
    try {
      const db = this.dao.getDb()
      // Only update if the new status is more severe than the current one
      // Hierarchy: NULL < intervened < blocked < delegated
      db.prepare(
        `UPDATE executions SET harness_status = ?
         WHERE id = ? AND (
           harness_status IS NULL
           OR (harness_status = 'intervened' AND ? IN ('blocked', 'delegated'))
           OR (harness_status = 'blocked' AND ? = 'delegated')
         )`,
      ).run(status, this.executionId, status, status)
    } catch (err) {
      console.error("[DetectorPipeline] Failed to update execution harness_status:", err)
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
            }, true) // skipStrategy: onBeforeNode handles delegation directly

            // For critical reports (e.g. process_conflict): delegate to agent
            // synchronously and await the decision before returning.
            for (const report of reports) {
              if (report.severity === "critical" && pipeline.strategyEngine) {
                // Set status to "intervening" while agent analyzes
                pipeline.updateNodeHarnessStatus(nodeId, "harness_intervening", report)

                const strategyResult = await pipeline.strategyEngine.handleReport(report)
                if (strategyResult.delegationResult) {
                  const dr = strategyResult.delegationResult
                  // Agent decided to block → return skip
                  if (dr.decision === "block_node") {
                    pipeline.updateNodeHarnessStatus(nodeId, "harness_blocked", report)
                    return { action: "skip" as const }
                  }
                  // Agent decided to proceed (node is safe after analysis)
                  if (dr.decision === "agent_takeover" && dr.takeoverOutput) {
                    pipeline.updateNodeHarnessStatus(nodeId, "harness_executed", report)
                    return {
                      action: "override" as const,
                      overrideResult: {
                        outputs: { result: dr.takeoverOutput },
                        status: "completed",
                        durationMs: 0,
                      },
                    }
                  }
                  // Other decisions (fix/guide/reconfigure) → proceed normally,
                  // the onNodeRetry/onFailureDecision hooks handle them
                  pipeline.updateNodeHarnessStatus(nodeId, "harness_modified", report)
                }
              }
            }

            if (typeof original === "function") {
              return original.call(target, nodeId, nodeType, nodeConfig)
            }
            return { action: "proceed" as const }
          }
        }

        // ── onBeforeToolCall: always intercept (agent tool interceptor) ──
        // Scans bash tool calls for dangerous patterns (kill/port binding).
        // Blocks dangerous calls, injects guidance, and resumes the agent session.
        if (prop === "onBeforeToolCall") {
          return async function (
            toolName: string,
            input: unknown,
          ): Promise<{ allow: boolean; reason?: string } | undefined> {
            // Only intercept bash tool calls
            if (toolName !== "Bash" && toolName !== "bash") {
              if (typeof original === "function") {
                return original.call(target, toolName, input)
              }
              return undefined
            }

            // Extract command string from input
            const command = typeof input === "string"
              ? input
              : typeof input === "object" && input !== null
                ? (input as any).command ?? (input as any).cmd ?? String(input)
                : ""

            // Use DangerousPatternMatcher to check for dangerous patterns
            const matcher = new DangerousPatternMatcher({
              hostPid: pipeline.hostPid ?? String(process.pid),
              hostPids: process.env.OCTOPUS_HOST_PIDS,
              hostPorts: pipeline.hostPorts ?? [],
            })
            const match = matcher.check(command)

            if (match.dangerous) {
              // Block the tool call and emit a diagnosis
              const report: DiagnosisReport = {
                id: `diagnosis-tool_interceptor-${Date.now()}`,
                timestamp: Date.now(),
                detector: "tool_interceptor",
                severity: "critical",
                executionId: pipeline.executionId,
                nodeId: "", // unknown at this point
                nodeType: "agent",
                pattern: match.pattern ?? "dangerous_command",
                evidence: [{ command, matchedPattern: match.pattern }],
                context: { retryCount: 0, nodeDurationMs: 0, workflowProgress: 0 },
              }
              pipeline.handleDiagnosis(report)

              // Return block with guidance
              return {
                allow: false,
                reason: `Blocked by harness tool interceptor: ${match.pattern}. ` +
                  `Do NOT kill host processes or bind to host ports. ` +
                  `Use --isolated mode for starting services, and never target $OCTOPUS_HOST_PID.`,
              }
            }

            // Safe command — pass through
            if (typeof original === "function") {
              return original.call(target, toolName, input)
            }
            return undefined
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
   * Update node_executions.harness_status and insert/update an agent_event
   * so harness activity shows in both the node UI (🛡️ icon) and log viewer.
   *
   * When status escalates (e.g. intervening → blocked), updates the existing
   * agent_event row in-place to avoid duplicate log entries.
   *
   * The optional `decisionContext` adds the `decision` field to the agent_event
   * content, enabling log rendering to show which decision type was applied.
   */
  private updateNodeHarnessStatus(
    nodeId: string,
    status: string,
    report: DiagnosisReport,
    decisionContext?: {
      decision?: HarnessDecisionType
      reasoning?: string
      [key: string]: any
    },
  ): void {
    try {
      const db = this.dao.getDb()
      const neId = `${this.executionId}-${nodeId}`
      const eventType = `harness_${report.detector}`

      // Update harness_status on the node execution
      db.prepare(
        `UPDATE node_executions SET harness_status = ? WHERE id = ?`,
      ).run(status, neId)

      const eventContent = JSON.stringify({
        detector: report.detector,
        severity: report.severity,
        pattern: report.pattern,
        evidence: report.evidence,
        status,
        ...(decisionContext ?? {}),
      })

      // Try to update an existing harness event for this node (avoid duplicates)
      // agent_events uses composite PK (node_execution_id, event_order) — no id column
      const existing = db.prepare(
        `SELECT event_order FROM agent_events WHERE node_execution_id = ? AND event_type = ? ORDER BY event_order DESC LIMIT 1`
      ).get(neId, eventType) as { event_order: number } | undefined

      if (existing) {
        // Escalate: update status in-place (e.g. intervening → blocked)
        db.prepare(
          `UPDATE agent_events SET content = ? WHERE node_execution_id = ? AND event_order = ?`
        ).run(eventContent, neId, existing.event_order)
      } else {
        // Insert new agent_event for the log viewer
        const eventOrder = Date.now()
        db.prepare(`
          INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length)
          VALUES (?, ?, 0, ?, ?, ?, ?)
        `).run(neId, eventOrder, eventType, eventOrder, eventContent, 200)
      }
    } catch (err) {
      // Non-fatal: harness status update failure shouldn't break the pipeline
      console.error("[DetectorPipeline] Failed to update node harness status:", err)
    }
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
