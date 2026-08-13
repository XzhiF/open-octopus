// packages/server/src/services/harness/detector-pipeline.ts
//
// DetectorPipeline — Layer 1 of the Harness.
// Creates per-execution detector instances and wraps EngineCallbacks with a Proxy
// to intercept relevant events and route them to detectors.
// When a detector produces a DiagnosisReport, it is persisted to harness_events
// and emitted as an SSE event.

import type { DiagnosisReport, HarnessSystemConfigParsed, DelegationResult, HarnessDecisionType } from "@octopus/shared"
import type { HarnessEvent, StrategyAction } from "@octopus/shared"
import { appendFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { BaseDetector } from "./base-detector"
import type { HarnessCallbackEvent } from "./base-detector"
import { StupidRetryDetector } from "./detectors/stupid-retry"
import { DeterministicErrorDetector } from "./detectors/deterministic-error"
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
  scriptOverride?: string
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
  workspacePath?: string
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
  private workspacePath: string
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

  /**
   * In-flight LLM delegation promises keyed by nodeId.
   * Populated by handleDiagnosis when async delegation starts;
   * consumed (awaited) by onBeforeRetry proxy before checking pendingActions.
   * This bridges the gap between fire-and-forget onNodeRetry and awaited onBeforeRetry.
   */
  private pendingDelegationPromises = new Map<string, Promise<void>>()

  /**
   * Current VarPool snapshot passed from engine's onBeforeRetry callback.
   * Used by buildDelegationContext to provide real-time variable state to the LLM.
   */
  currentPoolSnapshot?: Record<string, any>

  /**
   * Last failing inner node ID per loop node, tracked via onBranchEnd.
   * Used by onBeforeRetry to attribute harness events to the actual failing
   * inner node (e.g. "failing-task") rather than the loop container (e.g. "retry-loop").
   */
  private lastFailingInnerNode = new Map<string, string>()
  /** Track current iteration number per loop, set by onBranchStart. */
  private currentLoopIteration = new Map<string, number>()

  constructor(deps: DetectorPipelineDeps) {
    this.executionId = deps.executionId
    this.workspaceId = deps.workspaceId
    this.workspacePath = deps.workspacePath ?? ""
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

    // DeterministicErrorDetector: fires at attempt 1 for bash/python nodes.
    // StupidRetryDetector: fires at attempt 2+ (threshold=2) for any node.
    // They coexist without suppression — deterministic fires first, stupid_retry
    // acts as a fallback if the harness fix doesn't resolve the issue.
    if (d.deterministic_error?.enabled) {
      detectors.push(new DeterministicErrorDetector())
    }

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
   * Returns the delegation promise (if any) so callers can await it.
   */
  private handleDiagnosis(report: DiagnosisReport, skipStrategy: boolean = false): Promise<void> | undefined {
    // Inject current iteration into the report for UI display
    const iteration = this.currentLoopIteration.get(report.nodeId)
    if (iteration != null) {
      (report as any).iteration = iteration
    }

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
    // Use displayNodeId (inner failing node) for UI if available
    this.updateNodeHarnessStatus(report.displayNodeId ?? report.nodeId, "harness_intervening", report)
    // Also update the loop container's harness_status (purple ants UI) but no agent_event
    if (report.displayNodeId && report.displayNodeId !== report.nodeId) {
      this.updateContainerHarnessStatus(report.nodeId, "harness_intervening")
    }

    // Immediately mark execution-level harness_status as "intervened"
    // so the execution tree shows harness is working (purple ants)
    if (report.severity === "critical") {
      this.updateExecutionHarnessStatus("intervened")
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

    // Write to workspace logs
    this.writeHarnessLog({ type: "diagnosis", report })

    // Route to StrategyEngine (Layer 2) if available
    // skipStrategy = true when caller (onBeforeNode) handles delegation directly
    console.log(`[DetectorPipeline] handleDiagnosis: skipStrategy=${skipStrategy}, hasStrategyEngine=${!!this.strategyEngine}`)
    if (!skipStrategy && this.strategyEngine) {
      // Build delegation context from DB so the LLM can see VarPool + events
      console.log(`[DetectorPipeline] Building delegation context...`)
      const delegationContext = this.buildDelegationContext(report)
      console.log(`[DetectorPipeline] Context built: varpool=${JSON.stringify(delegationContext.varpoolSnapshot).slice(0,200)}, events=${delegationContext.recentEvents.length}`)
      const delegationPromise = this.strategyEngine.handleReport(report, delegationContext).then((result) => {
        if (result.delegationResult) {
          this.processDecision(report, result.delegationResult)
          return
        }

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

        if (result.delegate && !result.delegationResult) {
          this.pendingFailureActions.set(nodeId, { action: "delegate" })
        }
      }).catch((err) => {
        console.error("[DetectorPipeline] StrategyEngine error:", err)
      })

      // Store for cleanup and return so callers can await it
      this.pendingDelegationPromises.set(report.nodeId, delegationPromise)
      return delegationPromise
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
      this.updateHarnessStatus(nodeId, report.displayNodeId ?? nodeId, "harness_blocked", report)
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
    // displayNodeId targets the actual failing inner node for UI (e.g. "failing-task")
    // while nodeId targets the retried container (e.g. "retry-loop") for pendingActions
    const displayNodeId = report.displayNodeId ?? nodeId

    // Write delegation decision to workspace logs
    console.log(`[DetectorPipeline] processDecision: node=${nodeId}, decision=${result.decision}, varPoolPatches=${JSON.stringify(result.varPoolPatches)}, harnessHint=${result.harnessHint}`)
    this.writeHarnessLog({
      type: "delegation",
      nodeId,
      success: result.success,
      decision: result.decision,
      reasoning: result.reasoning,
      varPoolPatches: result.varPoolPatches,
      harnessHint: result.harnessHint,
      tokenUsage: result.tokenUsage,
    })

    if (!result.success) {
      // Failed delegation: treat as block_node (safe default)
      this.updateHarnessStatus(nodeId, displayNodeId, "harness_blocked", report, {
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
          scriptOverride: result.scriptOverride,
        })
        this.updateHarnessStatus(nodeId, displayNodeId, "harness_modified", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          varPoolPatches: result.varPoolPatches,
          harnessHint: result.harnessHint,
          scriptOverride: result.scriptOverride,
        })
        this.updateExecutionHarnessStatus("intervened")
        break

      case "guide_and_retry":
        this.pendingActions.set(nodeId, {
          action: "retry",
          harnessHint: result.harnessHint,
        })
        this.updateHarnessStatus(nodeId, displayNodeId, "harness_modified", report, {
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
        this.updateHarnessStatus(nodeId, displayNodeId, "harness_modified", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          modelOverride: result.modelOverride,
        })
        this.updateExecutionHarnessStatus("intervened")
        break

      case "agent_takeover": {
        // Build override result from takeover output (fallback to reasoning if missing)
        const takeoverResult = {
          status: "completed" as const,
          outputs: { result: result.takeoverOutput ?? result.reasoning },
          durationMs: 0,
          logLines: [`Harness agent takeover: ${result.reasoning.slice(0, 200)}`],
          exitCode: result.takeoverExitCode ?? 0,
        }

        // Set pendingActions so onBeforeRetry can return {action: "override"}
        // This is the primary path — overrides the current retry with a completed result
        this.pendingActions.set(nodeId, {
          action: "override",
          overrideResult: takeoverResult,
        })

        // Also set pendingFailureActions for onFailureDecision (fallback if retries exhausted)
        this.pendingFailureActions.set(nodeId, {
          action: "override",
          overrideResult: takeoverResult,
        })

        // Write overrideResult to DB for the engine to pick up on resume
        this.writeOverrideResultToDb(nodeId, {
          status: "completed",
          outputs: takeoverResult.outputs,
          exitCode: takeoverResult.exitCode,
        })
        this.updateHarnessStatus(nodeId, displayNodeId, "harness_executed", report, {
          decision: result.decision,
          reasoning: result.reasoning,
          takeoverOutput: result.takeoverOutput,
        })
        this.updateExecutionHarnessStatus("delegated")
        break
      }

      case "block_node":
        this.pendingBlockActions.set(nodeId, {
          action: "skip",
          overrideResult: {
            status: "failed",
            error: result.blockReason ?? "Blocked by harness agent",
          },
        })
        this.updateHarnessStatus(nodeId, displayNodeId, "harness_blocked", report, {
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
   * Non-fatal: the in-memory pendingActions path handles the primary flow.
   */
  private writeOverrideResultToDb(
    nodeId: string,
    overrideResult: { status: string; outputs?: Record<string, unknown>; exitCode?: number },
  ): void {
    try {
      const db = this.dao.getDb()
      const neId = `${this.executionId}-${nodeId}`
      // Check if override_result column exists (may not in older schemas)
      const cols = db.prepare("PRAGMA table_info(node_executions)").all() as Array<{ name: string }>
      if (cols.some(c => c.name === "override_result")) {
        db.prepare(
          `UPDATE node_executions SET override_result = ? WHERE id = ?`,
        ).run(JSON.stringify(overrideResult), neId)
      }
    } catch {
      // Non-fatal: in-memory pendingActions path handles the primary flow
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
   * Build DelegationContext from the database so the LLM agent can see:
   * - Current VarPool values (to know what variables exist and what to patch)
   * - Recent agent events (to understand the execution flow)
   * - Workflow YAML (to understand the node structure)
   */
  buildDelegationContext(report: DiagnosisReport): import("./agent-delegation").DelegationContext {
    let varpoolSnapshot: Record<string, any> = {}
    let recentEvents: any[] = []
    let workflowContent = ""
    let nodeConfig: any = null

    // 1. Use currentPoolSnapshot from engine if available (real-time state)
    if (this.currentPoolSnapshot) {
      varpoolSnapshot = this.currentPoolSnapshot
    }

    try {
      const db = this.dao.getDb()

      // 1b. Fallback: VarPool snapshot from DB if not provided by engine
      if (!this.currentPoolSnapshot) {
        const execRow = db.prepare(
          `SELECT var_pool, workflow_ref FROM executions WHERE id = ?`
        ).get(this.executionId) as { var_pool: string; workflow_ref: string } | undefined
        if (execRow?.var_pool) {
          try { varpoolSnapshot = JSON.parse(execRow.var_pool) } catch {}
        }
      }

      // 2. Recent agent events (last 20) for context
      const events = db.prepare(
        `SELECT event_type, content FROM agent_events
         WHERE node_execution_id LIKE ? || '%'
         ORDER BY event_order DESC LIMIT 20`
      ).all(this.executionId) as { event_type: string; content: string }[]
      recentEvents = events.reverse().map(e => {
        try { return { event_type: e.event_type, ...JSON.parse(e.content) } }
        catch { return { event_type: e.event_type, content: e.content } }
      })

      // 3. Workflow YAML from workspace
      const execRow2 = db.prepare(
        `SELECT workflow_ref FROM executions WHERE id = ?`
      ).get(this.executionId) as { workflow_ref: string } | undefined
      if (this.workspacePath && execRow2?.workflow_ref) {
        try {
          const { readFileSync } = require("fs")
          const { join } = require("path")
          const wfPath = join(this.workspacePath, "workflows", execRow2.workflow_ref)
          workflowContent = readFileSync(wfPath, "utf-8")
        } catch {
          // Fallback: try to find any YAML in the workflows dir
          try {
            const { readFileSync, readdirSync } = require("fs")
            const { join } = require("path")
            const wfDir = join(this.workspacePath, "workflows")
            const files = readdirSync(wfDir) as string[]
            const yamlFile = files.find((f: string) => f.endsWith(".yaml") || f.endsWith(".yml"))
            if (yamlFile) {
              workflowContent = readFileSync(join(wfDir, yamlFile), "utf-8")
            }
          } catch {}
        }
      }

      // 4. Node config from node_executions
      const neRow = db.prepare(
        `SELECT node_type FROM node_executions WHERE id = ?`
      ).get(`${this.executionId}-${report.nodeId}`) as { node_type: string } | undefined
      if (neRow) {
        nodeConfig = { nodeId: report.nodeId, nodeType: neRow.node_type }
      }
    } catch (err) {
      console.error("[DetectorPipeline] Failed to build delegation context:", err)
    }

    return { recentEvents, varpoolSnapshot, nodeConfig, workflowContent }
  }

  /**
   * Write harness event to workspace logs/<executionId>/harness.jsonl
   */
  private writeHarnessLog(event: { type: string; [key: string]: unknown }): void {
    if (!this.workspacePath) return
    try {
      const logDir = join(this.workspacePath, "logs", this.executionId)
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
      const line = JSON.stringify({ ts: Date.now(), ...event }) + "\n"
      appendFileSync(join(logDir, "harness.jsonl"), line, "utf-8")
    } catch {
      // Non-fatal: log file writing failure should not break the pipeline
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
            context?: { poolSnapshot?: Record<string, any> },
          ) {
            // ── Synchronous Detection + Delegation Bridge ─────────────
            // Engine callback order for attempt N that failed:
            //   1. onBeforeRetry(N)  ← WE ARE HERE (awaited by engine)
            //   2. onNodeRetry(N)    ← notification (fires later)
            //   3. sleep(delayMs)
            //   4. attempt N+1
            //
            // Run detectors NOW (synchronously), start delegation, and
            // await the result. This ensures pendingActions is populated
            // before the engine proceeds to the next attempt.

            // Store pool snapshot for use in buildDelegationContext
            if (context?.poolSnapshot) {
              pipeline.currentPoolSnapshot = context.poolSnapshot
            }

            const retryEvent = {
              type: "nodeRetry" as const,
              nodeId,
              attempt,
              maxAttempts: 0,
              delayMs: 0,
              result: lastResult,
            }

            for (const detector of pipeline.detectors) {
              try {
                const report = detector.observe(retryEvent)
                if (report) {
                  if (!report.executionId) {
                    report.executionId = pipeline.executionId
                  }
                  // If this is a loop container with a known failing inner node,
                  // attribute harness events to the inner node for UI clarity.
                  // The engine still retries the loop (correct behavior), but
                  // harness UI shows the actual failing node (e.g. "failing-task").
                  const innerNodeId = pipeline.lastFailingInnerNode.get(nodeId)
                  if (innerNodeId) {
                    report.displayNodeId = innerNodeId
                  }
                  // handleDiagnosis persists + starts delegation, returns promise.
                  // Await the delegation directly — no timeout.
                  // Rationale: if detection fired, we NEED the harness decision.
                  // Retrying without the fix wastes a retry attempt.
                  // The LLM provider has its own internal timeout (60-120s)
                  // which handles hangs. The delegation promise never rejects
                  // (errors are caught internally in handleDiagnosis).
                  const delegationPromise = pipeline.handleDiagnosis(report)
                  if (delegationPromise) {
                    await delegationPromise
                  }
                }
              } catch (err) {
                console.error(
                  `[DetectorPipeline] Error in detector ${detector.name} during onBeforeRetry:`,
                  err,
                )
              }
            }

            // Now check ALL pending action maps (populated by processDecision above)
            // Different decision types store to different maps:
            //   fix/guide/reconfigure → pendingActions
            //   agent_takeover        → pendingActions + pendingFailureActions
            //   block_node            → pendingBlockActions
            const pending = pipeline.pendingActions.get(nodeId)
              ?? pipeline.pendingBlockActions.get(nodeId)
            if (pending) {
              pipeline.pendingActions.delete(nodeId)
              pipeline.pendingBlockActions.delete(nodeId)
              console.log(`[DetectorPipeline] onBeforeRetry returning pending action for ${nodeId}:`, JSON.stringify(pending))
              return pending
            }
            console.log(`[DetectorPipeline] onBeforeRetry: no pending action for ${nodeId}, returning default retry`)
            if (typeof original === "function") {
              return original.call(target, nodeId, attempt, lastResult, context)
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
            // If harness blocked this node, abort the workflow
            if (pipeline.pendingBlockActions.has(nodeId)) {
              pipeline.pendingBlockActions.delete(nodeId)
              return { action: "abort" as const }
            }
            // No harness opinion — defer to engine's failure_strategy
            // (don't default to "continue" which overrides fail_fast)
            if (typeof original === "function") {
              return original.call(target, nodeId, error, currentStrategy)
            }
            return { action: "abort" as const }
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

                const strategyResult = await pipeline.strategyEngine.handleReport(report, pipeline.buildDelegationContext(report))
                if (strategyResult.delegationResult) {
                  const dr = strategyResult.delegationResult
                  // Log delegation to workspace logs
                  pipeline.writeHarnessLog({
                    type: "delegation", nodeId,
                    success: dr.success, decision: dr.decision,
                    reasoning: dr.reasoning, tokenUsage: dr.tokenUsage,
                  })
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
              pipeline.pendingDelegationPromises.delete(nodeId)
              // NOTE: lastFailingInnerNode is NOT cleared here — it must persist
              // across retries. It's cleaned up in destroy() instead.
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
              // Detection + delegation now happens in onBeforeRetry (which fires
              // BEFORE onNodeRetry in the engine). onNodeRetry is pure notification:
              // just call the original callback for SSE/DB logging.
              // Routing nodeRetry to detectors here would double-count the event
              // (StupidRetryDetector already observed it in onBeforeRetry).
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

          case "onBranchStart":
            return function (nodeExecutionId: string, iteration: number) {
              // Track current iteration per loop so harness events carry iteration info
              const loopId = nodeExecutionId.replace(/-iter-\d+$/, "")
              pipeline.currentLoopIteration.set(loopId, iteration)
              if (typeof original === "function") {
                return original.call(target, nodeExecutionId, iteration)
              }
            }

          case "onBranchEnd":
            return function (
              nodeExecutionId: string,
              iteration: number,
              status: string,
              nodeResults?: { nodeId: string; status: string; durationMs?: number; error?: string }[],
            ) {
              // Track the last failing inner node for each loop container.
              // This lets onBeforeRetry attribute harness events to the actual
              // failing node (e.g. "failing-task") instead of the loop (e.g. "retry-loop").
              if (status === "failed" && nodeResults) {
                const failedNode = nodeResults.find(n => n.status === "failed")
                if (failedNode) {
                  const loopId = nodeExecutionId.replace(/-iter-\d+$/, "")
                  pipeline.lastFailingInnerNode.set(loopId, failedNode.nodeId)
                }
              }
              if (typeof original === "function") {
                return original.call(target, nodeExecutionId, iteration, status, nodeResults)
              }
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
  /**
   * Update harness status on both the display node (inner failing node) and
   * the container node (loop container). The agent_event (log entry) is only
   * written for the display node — the loop container gets the harness_status
   * DB field (for purple ants UI) but no separate log entry.
   */
  private updateHarnessStatus(
    nodeId: string,
    displayNodeId: string,
    status: string,
    report: DiagnosisReport,
    decisionContext?: {
      decision?: HarnessDecisionType
      reasoning?: string
      [key: string]: any
    },
  ): void {
    // Full update for display node: harness_status + agent_event
    this.updateNodeHarnessStatus(displayNodeId, status, report, decisionContext)
    // Container node: only update harness_status (no agent_event)
    if (displayNodeId !== nodeId) {
      this.updateContainerHarnessStatus(nodeId, status)
    }
  }

  /**
   * Update only the harness_status column on a node_execution, without
   * inserting an agent_event. Used for loop containers that need the
   * purple ants UI but shouldn't have a separate log entry.
   */
  private updateContainerHarnessStatus(nodeId: string, status: string): void {
    const neId = `${this.executionId}-${nodeId}`
    try {
      const db = this.dao.getDb()
      db.prepare(`UPDATE node_executions SET harness_status = ? WHERE id = ?`).run(status, neId)
    } catch (err) {
      console.error(`[DetectorPipeline] Failed to update container harness_status for ${neId}:`, err)
    }
  }

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
    console.log(`[DetectorPipeline] updateNodeHarnessStatus: nodeId=${nodeId}, status=${status}, decision=${decisionContext?.decision}`)
    const neId = `${this.executionId}-${nodeId}`
    const eventType = `harness_${report.detector}`

    let db: ReturnType<typeof this.dao.getDb>
    try {
      db = this.dao.getDb()
    } catch {
      // DAO doesn't expose getDb (e.g. test mocks) — skip agent_event persistence
      console.log(`[DetectorPipeline] updateNodeHarnessStatus: DAO getDb not available, skipping`)
      return
    }

    // Step 1: Update harness_status on the node execution
    try {
      db.prepare(
        `UPDATE node_executions SET harness_status = ? WHERE id = ?`,
      ).run(status, neId)
    } catch (err) {
      console.error(`[DetectorPipeline] Failed to update harness_status for ${neId}:`, err)
    }

    // Look up current iteration for the loop container (if node is inside a loop)
    const iteration = this.currentLoopIteration.get(report.nodeId)

    const eventContent = JSON.stringify({
      detector: report.detector,
      severity: report.severity,
      pattern: report.pattern,
      evidence: report.evidence,
      status,
      ...(iteration != null ? { iteration } : {}),
      ...(decisionContext ?? {}),
    })

    // Step 2: Insert or update agent_event for the log viewer
    try {
      const existing = db.prepare(
        `SELECT event_order FROM agent_events WHERE node_execution_id = ? AND event_type = ? ORDER BY event_order DESC LIMIT 1`
      ).get(neId, eventType) as { event_order: number } | undefined

      if (existing) {
        // Escalate: update status in-place (e.g. intervening → blocked)
        console.log(`[DetectorPipeline] updateNodeHarnessStatus: updating existing event_order=${existing.event_order}`)
        db.prepare(
          `UPDATE agent_events SET content = ? WHERE node_execution_id = ? AND event_order = ?`
        ).run(eventContent, neId, existing.event_order)
      } else {
        // Insert new agent_event — use the next sequential event_order after the
        // node's current max so harness events appear in chronological position
        // in the log viewer (between retries, not after all execution events).
        const maxRow = db.prepare(
          `SELECT COALESCE(MAX(event_order), -1) as max_order FROM agent_events WHERE node_execution_id = ?`
        ).get(neId) as { max_order: number } | undefined
        const eventOrder = (maxRow?.max_order ?? -1) + 1
        const ts = Date.now()
        console.log(`[DetectorPipeline] updateNodeHarnessStatus: inserting new event neId=${neId}, eventType=${eventType}, eventOrder=${eventOrder}, content_length=${eventContent.length}`)
        const stmt = db.prepare(`
          INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length)
          VALUES (?, ?, 0, ?, ?, ?, ?)
        `)
        const result = stmt.run(neId, eventOrder, eventType, ts, eventContent, eventContent.length)
        console.log(`[DetectorPipeline] updateNodeHarnessStatus: insert result: changes=${result.changes}, lastInsertRowid=${result.lastInsertRowid}`)

        // Verify the insert immediately
        try {
          const verify = db.prepare(`SELECT event_type, event_order FROM agent_events WHERE node_execution_id = ? AND event_order = ?`).get(neId, eventOrder) as any
          console.log(`[DetectorPipeline] updateNodeHarnessStatus: verify insert: ${verify ? `found ${verify.event_type} at ${verify.event_order}` : 'NOT FOUND'}`)
        } catch (verifyErr) {
          console.error(`[DetectorPipeline] updateNodeHarnessStatus: verify query failed:`, verifyErr)
        }
      }
    } catch (err) {
      console.error(
        `[DetectorPipeline] Failed to insert/update agent_event for ${neId} (type=${eventType}):`,
        err,
      )
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
    this.pendingDelegationPromises.clear()
    this.lastFailingInnerNode.clear()
    this.currentLoopIteration.clear()
  }
}
