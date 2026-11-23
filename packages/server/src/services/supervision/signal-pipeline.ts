// SignalPipeline — detectors + engine hooks, no policy.
//
// It owns the four callbacks the engine awaits/observes, feeds detector
// signals to the RuntimeSupervisor, and keeps the per-node UI state
// (node_executions.harness_status + agent_events) in sync. It NEVER calls an
// LLM and never decides what to do about a signal.

import type { DiagnosisReport, HarnessEvent } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { BaseDetector } from "../harness/base-detector"
import type { HarnessCallbackEvent } from "../harness/base-detector"
import { StupidRetryDetector } from "../harness/detectors/stupid-retry"
import { DeterministicErrorDetector } from "../harness/detectors/deterministic-error"
import { ModelMismatchDetector } from "../harness/detectors/model-mismatch"
import { ProcessConflictDetector } from "../harness/detectors/process-conflict"
import { TimeoutCascadeDetector } from "../harness/detectors/timeout-cascade"
import { DangerousPatternMatcher } from "../harness/dangerous-pattern-matcher"

/** Pending retry action, consumed by onBeforeRetry. */
export interface PendingRetryAction {
  harnessHint?: string
  modelOverride?: string
  varPoolPatches?: Record<string, string>
  scriptOverride?: string
  action: "retry" | "skip" | "abort" | "override"
  overrideResult?: any
  continueSubsequent?: boolean
}

/** Pending failure action, consumed by onFailureDecision. */
export interface PendingFailureAction {
  action: "continue" | "abort" | "delegate" | "override"
  overrideResult?: any
  continueSubsequent?: boolean
}

/** Pending block action used by onBeforeNode. */
export interface PendingBlockAction {
  action: "skip"
  continueSubsequent?: boolean
}

/** What the supervisor tells the hook to do after processing a signal. */
export interface SignalVerdict {
  action: "block" | "abort" | "proceed"
  reason?: string
  continueSubsequent?: boolean
}

export interface SignalPipelineDeps {
  executionId: string
  workspaceId: string
  /** SSE channel id (org:path composite). Defaults to workspaceId. */
  sseWorkspaceId?: string
  workspacePath?: string
  dao: HarnessDAO
  sse?: Pick<SSEService, "emit"> | null
  hostPid?: string
  hostPorts?: string[]
  /** Supervisor entry point: guards first, then incident routing. */
  onSignal(report: DiagnosisReport, phase: string): Promise<SignalVerdict | null>
  /** True when an incident for this node is unresolved (failure hook → pause). */
  hasOpenIncident(nodeId: string): boolean
}

const DETECTOR_DEFAULTS = {
  deterministic_error: true,
  stupid_retry: { enabled: true, threshold: 2 },
  model_mismatch: true,
  process_conflict: true,
  timeout_cascade: { enabled: true, threshold: 3 },
} as const

export class SignalPipeline {
  private detectors: BaseDetector[] = []
  private executionId: string
  private workspaceId: string
  private sseWorkspaceId: string
  private workspacePath: string
  private dao: HarnessDAO
  private sse: Pick<SSEService, "emit"> | null
  private hostPid: string
  private hostPorts: string[]
  private deps: SignalPipelineDeps

  currentPoolSnapshot?: Record<string, any>
  private lastFailingInnerNode = new Map<string, string>()
  private currentLoopIteration = new Map<string, number>()
  private decisionQueues: {
    consumeRetry(nodeId: string): PendingRetryAction | null
    consumeFailure(nodeId: string): PendingFailureAction | null
  } | null = null

  constructor(deps: SignalPipelineDeps) {
    this.deps = deps
    this.executionId = deps.executionId
    this.workspaceId = deps.workspaceId
    this.sseWorkspaceId = deps.sseWorkspaceId ?? deps.workspaceId
    this.workspacePath = deps.workspacePath ?? ""
    this.dao = deps.dao
    this.sse = deps.sse ?? null
    this.hostPid = deps.hostPid ?? String(process.pid)
    this.hostPorts = deps.hostPorts ?? []
    this.detectors = this.createDetectors()
  }

  get detectorCount(): number {
    return this.detectors.length
  }

  private createDetectors(): BaseDetector[] {
    const detectors: BaseDetector[] = []
    if (DETECTOR_DEFAULTS.deterministic_error) detectors.push(new DeterministicErrorDetector())
    if (DETECTOR_DEFAULTS.stupid_retry.enabled) {
      detectors.push(new StupidRetryDetector({ threshold: DETECTOR_DEFAULTS.stupid_retry.threshold }))
    }
    if (DETECTOR_DEFAULTS.model_mismatch) detectors.push(new ModelMismatchDetector())
    if (DETECTOR_DEFAULTS.process_conflict) {
      detectors.push(new ProcessConflictDetector({ hostPid: this.hostPid, hostPorts: this.hostPorts }))
    }
    if (DETECTOR_DEFAULTS.timeout_cascade.enabled) {
      detectors.push(new TimeoutCascadeDetector({ threshold: DETECTOR_DEFAULTS.timeout_cascade.threshold }))
    }
    return detectors
  }

  /** Route an event and hand every report to the supervisor. */
  async routeEvent(event: HarnessCallbackEvent, phase: string): Promise<SignalVerdict | null> {
    let verdict: SignalVerdict | null = null
    for (const detector of this.detectors) {
      try {
        const report = detector.observe(event)
        if (!report) continue
        if (!report.executionId) report.executionId = this.executionId
        this.attachDisplayNode(report)
        this.persistReport(report)

        this.markNodeStatus(report.displayNodeId ?? report.nodeId, "harness_intervening", report)
        if (report.displayNodeId && report.displayNodeId !== report.nodeId) {
          this.markContainerStatus(report.nodeId, "harness_intervening")
        }
        if (report.severity === "critical") this.updateExecutionHarnessStatus("intervened")
        this.emitDiagnosis(report)
        this.writeHarnessLog({ type: "diagnosis", phase, report })

        const result = await this.deps.onSignal(report, phase)
        if (result && (result.action === "block" || result.action === "abort")) {
          verdict = result
        }
      } catch (err) {
        console.error(`[SignalPipeline] detector ${detector.name} failed:`, err)
      }
    }
    return verdict
  }

  private attachDisplayNode(report: DiagnosisReport): void {
    const inner = this.lastFailingInnerNode.get(report.nodeId)
    if (inner) report.displayNodeId = inner
    const iteration = this.currentLoopIteration.get(report.nodeId)
    if (iteration != null) (report as any).iteration = iteration
  }

  private persistReport(report: DiagnosisReport): void {
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
      console.error("[SignalPipeline] failed to persist harness event:", err)
    }
  }

  private emitDiagnosis(report: DiagnosisReport): void {
    try {
      this.sse?.emit(this.sseWorkspaceId, {
        event: "harness_diagnosis",
        data: { executionId: report.executionId, report },
      })
    } catch (err) {
      console.error("[SignalPipeline] SSE emit failed:", err)
    }
  }

  private writeHarnessLog(event: Record<string, unknown>): void {
    if (!this.workspacePath) return
    try {
      const logDir = join(this.workspacePath, "logs", this.executionId)
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
      appendFileSync(join(logDir, "harness.jsonl"), JSON.stringify({ ts: Date.now(), ...event }) + "\n", "utf-8")
    } catch {
      /* non-fatal */
    }
  }

  // ── Engine callback wrapper ────────────────────────────────────────

  wrapCallbacks(callbacks: EngineCallbacks): EngineCallbacks {
    const pipeline = this

    return new Proxy(callbacks, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver)

        if (prop === "onBeforeNode") {
          return async function (nodeId: string, nodeType: string, nodeConfig: any) {
            const verdict = await pipeline.routeEvent(
              { type: "beforeNode", nodeId, nodeType, nodeConfig },
              "before_node",
            )
            if (verdict?.action === "block") {
              pipeline.markNodeStatus(nodeId, "harness_blocked", { nodeId } as DiagnosisReport)
              return {
                action: "skip" as const,
                continueSubsequent: verdict.continueSubsequent ?? true,
              }
            }
            if (typeof original === "function") {
              return original.call(target, nodeId, nodeType, nodeConfig)
            }
            return { action: "proceed" as const }
          }
        }

        if (prop === "onBeforeRetry") {
          return async function (
            nodeId: string,
            attempt: number,
            lastResult: any,
            context?: { poolSnapshot?: Record<string, any> },
          ) {
            if (context?.poolSnapshot) pipeline.currentPoolSnapshot = context.poolSnapshot

            const verdict = await pipeline.routeEvent(
              {
                type: "nodeRetry",
                nodeId,
                attempt,
                maxAttempts: 0,
                delayMs: 0,
                result: lastResult,
              },
              "before_retry",
            )
            if (verdict?.action === "abort") {
              return { action: "abort" as const }
            }
            if (verdict?.action === "block") {
              return {
                action: "skip" as const,
                continueSubsequent: verdict.continueSubsequent ?? true,
              }
            }

            // A decision resolved by the owner is consumed here.
            const pending = pipeline.decisionQueues?.consumeRetry(nodeId) ?? null
            if (pending) return pending

            if (typeof original === "function") {
              return original.call(target, nodeId, attempt, lastResult, context)
            }
            return { action: "retry" }
          }
        }

        if (prop === "onFailureDecision") {
          return async function (nodeId: string, error: string, currentStrategy: string) {
            const pending = pipeline.decisionQueues?.consumeFailure(nodeId)
            if (pending) return pending

            // Safe default: an unresolved incident means a human/agent wants to
            // look before the engine gives up. Pause instead of aborting.
            const open = pipeline.deps.hasOpenIncident(nodeId)
            if (process.env.OCTOPUS_SUPERVISION_DEBUG) {
              console.log(`[SignalPipeline] onFailureDecision node=${nodeId} openIncident=${open}`)
            }
            if (open) {
              return { action: "delegate" as const }
            }

            if (typeof original === "function") {
              return original.call(target, nodeId, error, currentStrategy)
            }
            return { action: "abort" as const }
          }
        }

        if (prop === "onBeforeToolCall") {
          return async function (
            toolName: string,
            input: unknown,
          ): Promise<{ allow: boolean; reason?: string } | undefined> {
            if (toolName !== "Bash" && toolName !== "bash") {
              if (typeof original === "function") return original.call(target, toolName, input)
              return undefined
            }
            const command =
              typeof input === "string"
                ? input
                : typeof input === "object" && input !== null
                  ? (input as any).command ?? (input as any).cmd ?? String(input)
                  : ""
            const matcher = new DangerousPatternMatcher({
              hostPid: pipeline.hostPid,
              hostPids: process.env.OCTOPUS_HOST_PIDS,
              hostPorts: pipeline.hostPorts,
            })
            const match = matcher.check(command)
            if (!match.dangerous) {
              if (typeof original === "function") return original.call(target, toolName, input)
              return undefined
            }
            const report: DiagnosisReport = {
              id: `diagnosis-tool_interceptor-${Date.now()}`,
              timestamp: Date.now(),
              detector: "tool_interceptor",
              severity: "critical",
              executionId: pipeline.executionId,
              nodeId: "",
              nodeType: "agent",
              pattern: match.pattern ?? "dangerous_command",
              evidence: [{ command, matchedPattern: match.pattern }],
              context: { retryCount: 0, nodeDurationMs: 0, workflowProgress: 0 },
            }
            pipeline.persistReport(report)
            pipeline.emitDiagnosis(report)
            await pipeline.deps.onSignal(report, "before_node")
            return {
              allow: false,
              reason:
                `Blocked by runtime guard: ${match.pattern}. ` +
                "Do NOT kill host processes or bind to host ports. " +
                "Use --isolated mode for starting services, and never target $OCTOPUS_HOST_PID.",
            }
          }
        }

        if (typeof original !== "function") return original

        switch (prop) {
          case "onNodeStart":
            return function (nodeId: string, nodeType: string) {
              void pipeline.routeEvent({ type: "nodeStart", nodeId, nodeType }, "node_end")
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
              void pipeline.routeEvent(
                { type: "nodeEnd", nodeId, status, durationMs, result, nodeType },
                "node_end",
              )
              return original.call(target, nodeId, status, durationMs, result, nodeType)
            }

          case "onAgentEvent":
            return function (nodeId: string, event: any) {
              void pipeline.routeEvent({ type: "agentEvent", nodeId, event }, "node_end")
              return original.call(target, nodeId, event)
            }

          case "onError":
            return function (nodeId: string, error: string) {
              void pipeline.routeEvent({ type: "error", nodeId, error }, "node_end")
              return original.call(target, nodeId, error)
            }

          case "onBranchStart":
            return function (nodeExecutionId: string, iteration: number) {
              const loopId = nodeExecutionId.replace(/-iter-\d+$/, "")
              pipeline.currentLoopIteration.set(loopId, iteration)
              return original.call(target, nodeExecutionId, iteration)
            }

          case "onBranchEnd":
            return function (
              nodeExecutionId: string,
              iteration: number,
              status: string,
              nodeResults?: { nodeId: string; status: string; durationMs?: number; error?: string }[],
            ) {
              if (status === "failed" && nodeResults) {
                const failedNode = nodeResults.find((n) => n.status === "failed")
                if (failedNode) {
                  const loopId = nodeExecutionId.replace(/-iter-\d+$/, "")
                  pipeline.lastFailingInnerNode.set(loopId, failedNode.nodeId)
                }
              }
              return original.call(target, nodeExecutionId, iteration, status, nodeResults)
            }

          default:
            return original
        }
      },
    })
  }

  /** RuntimeSupervisor installs its decision queues here. */
  installDecisionQueues(queues: {
    consumeRetry(nodeId: string): PendingRetryAction | null
    consumeFailure(nodeId: string): PendingFailureAction | null
  }): void {
    this.decisionQueues = queues
  }

  // ── DB status helpers ──────────────────────────────────────────────

  private markContainerStatus(nodeId: string, status: string): void {
    try {
      this.dao.getDb().prepare("UPDATE node_executions SET harness_status = ? WHERE id = ?")
        .run(status, `${this.executionId}-${nodeId}`)
    } catch (err) {
      console.error("[SignalPipeline] container status update failed:", err)
    }
  }

  private markNodeStatus(
    nodeId: string,
    status: string,
    report: DiagnosisReport,
    decisionContext?: Record<string, unknown>,
  ): void {
    if (!nodeId) return
    const neId = `${this.executionId}-${nodeId}`
    let db: ReturnType<HarnessDAO["getDb"]>
    try {
      db = this.dao.getDb()
    } catch {
      return
    }
    try {
      db.prepare("UPDATE node_executions SET harness_status = ? WHERE id = ?").run(status, neId)
    } catch (err) {
      console.error(`[SignalPipeline] harness_status update failed for ${neId}:`, err)
    }

    const iteration = this.currentLoopIteration.get(report.nodeId)
    const content = JSON.stringify({
      detector: report.detector,
      severity: report.severity,
      pattern: report.pattern,
      evidence: report.evidence,
      status,
      ...(iteration != null ? { iteration } : {}),
      ...(decisionContext ?? {}),
    })
    const eventType = `harness_${report.detector}`
    try {
      const existing = db
        .prepare(
          `SELECT event_order FROM agent_events
           WHERE node_execution_id = ? AND event_type = ? ORDER BY event_order DESC LIMIT 1`,
        )
        .get(neId, eventType) as { event_order: number } | undefined
      if (existing) {
        db.prepare(
          "UPDATE agent_events SET content = ? WHERE node_execution_id = ? AND event_order = ?",
        ).run(content, neId, existing.event_order)
      } else {
        const maxRow = db
          .prepare("SELECT COALESCE(MAX(event_order), -1) AS max_order FROM agent_events WHERE node_execution_id = ?")
          .get(neId) as { max_order: number } | undefined
        db.prepare(
          `INSERT INTO agent_events
            (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length)
           VALUES (?, ?, 0, ?, ?, ?, ?)`,
        ).run(neId, (maxRow?.max_order ?? -1) + 1, eventType, Date.now(), content, content.length)
      }
    } catch (err) {
      console.error(`[SignalPipeline] agent_event write failed for ${neId}:`, err)
    }
  }

  updateExecutionHarnessStatus(status: "intervened" | "blocked" | "delegated"): void {
    try {
      this.dao.getDb().prepare(
        `UPDATE executions SET harness_status = ?
         WHERE id = ? AND (
           harness_status IS NULL
           OR (harness_status = 'intervened' AND ? IN ('blocked', 'delegated'))
           OR (harness_status = 'blocked' AND ? = 'delegated')
         )`,
      ).run(status, this.executionId, status, status)
    } catch (err) {
      console.error("[SignalPipeline] execution harness_status update failed:", err)
    }
  }

  /** Update the node UI after a decision lands. */
  markDecisionApplied(report: DiagnosisReport, status: string, decision: Record<string, unknown>): void {
    this.markNodeStatus(report.displayNodeId ?? report.nodeId, status, report, decision)
    this.updateExecutionHarnessStatus(status === "harness_blocked" ? "blocked" : "intervened")
  }

  destroy(): void {
    for (const detector of this.detectors) {
      try {
        detector.destroy()
      } catch {
        /* non-fatal */
      }
    }
    this.detectors = []
    this.lastFailingInnerNode.clear()
    this.currentLoopIteration.clear()
  }
}
