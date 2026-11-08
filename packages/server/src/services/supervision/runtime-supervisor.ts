// RuntimeSupervisor — the per-execution orchestrator.
//
//   detector signal
//     → hard guards (code, synchronous, cannot be bypassed)
//     → Incident (persisted, one open per node+kind)
//     → OwnerResolver → ChatSupervisor.notify (fire-and-forget)
//     → owner resolves through a tool → Decision
//     → in-hook pending action OR ActionExecutor (paused/failed execution)
//
// It never calls an LLM and never blocks an engine hook on a chat turn.

import type Database from "better-sqlite3"
import type {
  Decision,
  DecisionType,
  DiagnosisReport,
  Incident,
  IncidentRecord,
  Supervisor,
} from "@octopus/shared"
import { DEFAULT_ALLOWED_ACTIONS, summarizeSignal } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { IncidentStore } from "./incident-store"
import { OwnerResolver, type OwnerTarget } from "./owner-resolver"
import { ActionExecutor } from "./action-executor"
import type { HardGuard } from "./hard-guards"
import { evaluateHardGuards } from "./hard-guards"
import { ChatSupervisor } from "./chat-supervisor"
import { HumanSupervisor } from "./human-supervisor"
import {
  SignalPipeline,
  type PendingFailureAction,
  type PendingRetryAction,
  type SignalVerdict,
} from "./signal-pipeline"

const INCIDENT_DEADLINE_MS = 15 * 60 * 1000

export interface RuntimeSupervisorDeps {
  executionId: string
  /** DB workspace id (UUID) — the identity chat tools and REST routes use. */
  workspaceId: string
  /** SSE channel id (org:path composite). Defaults to workspaceId. */
  sseWorkspaceId?: string
  db: Database.Database
  dao: HarnessDAO
  sse?: Pick<SSEService, "emit"> | null
  workspacePath?: string
  hostPid?: string
  hostPorts?: string[]
  hardGuards: HardGuard[]
  actionExecutor: ActionExecutor
  ownerResolver: OwnerResolver
  incidentStore: IncidentStore
}

export interface ResolveResult {
  ok: boolean
  detail: string
  status: string
}

export class RuntimeSupervisor {
  readonly executionId: string
  readonly workspaceId: string
  private pipeline: SignalPipeline
  private store: IncidentStore
  private ownerResolver: OwnerResolver
  private actionExecutor: ActionExecutor
  private hardGuards: HardGuard[]
  private sse: Pick<SSEService, "emit"> | null
  private sseWorkspaceId: string
  private db: Database.Database
  private owner: OwnerTarget | null | undefined = undefined
  private lastReport = new Map<string, DiagnosisReport>()
  private pendingRetry = new Map<string, PendingRetryAction>()
  private pendingFailure = new Map<string, PendingFailureAction>()

  constructor(private deps: RuntimeSupervisorDeps) {
    this.executionId = deps.executionId
    this.workspaceId = deps.workspaceId
    this.store = deps.incidentStore
    this.ownerResolver = deps.ownerResolver
    this.actionExecutor = deps.actionExecutor
    this.hardGuards = deps.hardGuards
    this.sse = deps.sse ?? null
    this.sseWorkspaceId = deps.sseWorkspaceId ?? deps.workspaceId
    this.db = deps.db

    this.pipeline = new SignalPipeline({
      executionId: deps.executionId,
      workspaceId: deps.workspaceId,
      sseWorkspaceId: deps.sseWorkspaceId,
      workspacePath: deps.workspacePath,
      dao: deps.dao,
      sse: deps.sse,
      hostPid: deps.hostPid,
      hostPorts: deps.hostPorts,
      onSignal: (report, phase) => this.onSignal(report, phase),
      // Pause on failure only when somebody can actually act. An `unowned`
      // incident is recorded and visible, but a scheduled/bare execution must
      // not be stranded at "paused" forever with no owner — it falls back to
      // the engine's own failure_strategy.
      hasOpenIncident: (nodeId) =>
        this.store.findOpenForNode(this.executionId, nodeId) !== null &&
        this.getOwner() !== null,
    })
    this.pipeline.installDecisionQueues({
      consumeRetry: (nodeId) => this.consumeRetry(nodeId),
      consumeFailure: (nodeId) => this.consumeFailure(nodeId),
    })
  }

  onExecutionStart(callbacks: EngineCallbacks): EngineCallbacks {
    // Resolve the owner once, at start; ownership is execution-level.
    this.owner = this.ownerResolver.resolve(this.executionId)
    return this.pipeline.wrapCallbacks(callbacks)
  }

  onExecutionEnd(): void {
    this.pipeline.destroy()
    this.pendingRetry.clear()
    this.pendingFailure.clear()
    this.lastReport.clear()
  }

  getOwner(): OwnerTarget | null {
    if (this.owner === undefined) this.owner = this.ownerResolver.resolve(this.executionId)
    return this.owner
  }

  // ── Signal handling ────────────────────────────────────────────────

  private async onSignal(report: DiagnosisReport, phase: string): Promise<SignalVerdict | null> {
    this.lastReport.set(report.nodeId, report)

    // 1) Hard guards always win, synchronously, before any incident routing.
    const guard = evaluateHardGuards(this.hardGuards, report)
    if (guard) {
      const record = this.store.open(this.buildIncident(report, phase, guard.reason, []))
      const decision: Decision =
        guard.action === "block"
          ? { type: "block", reason: guard.reason, continueSubsequent: guard.continueSubsequent }
          : { type: "abort", reason: guard.reason }
      this.store.resolve(record.id, decision, "policy")
      this.pipeline.markDecisionApplied(report, "harness_blocked", {
        decision: decision.type,
        reason: guard.reason,
        source: "policy",
      })
      this.emit("incident_resolved", record.id, { decision, source: "policy" })
      return {
        action: guard.action,
        reason: guard.reason,
        continueSubsequent: guard.continueSubsequent,
      }
    }

    // 2) Everything else becomes a deferred incident. Never await the owner.
    const incident = this.store.open(this.buildIncident(report, phase))
    this.dispatch(incident, report)
    return null
  }

  private buildIncident(
    report: DiagnosisReport,
    phase: string,
    reasonOverride?: string,
    allowedActions: DecisionType[] = DEFAULT_ALLOWED_ACTIONS,
  ) {
    const first = report.evidence[0] ?? {}
    const summary =
      reasonOverride ??
      summarizeSignal({
        detector: report.detector,
        pattern: report.pattern,
        nodeId: report.displayNodeId ?? report.nodeId,
        error: typeof first.errorMessage === "string" ? first.errorMessage : undefined,
        attempts: typeof first.attempt === "number" ? first.attempt : undefined,
      })
    return {
      executionId: this.executionId,
      workspaceId: this.workspaceId,
      nodeId: report.nodeId,
      displayNodeId: report.displayNodeId,
      phase: phase as Incident["phase"],
      severity: report.severity,
      kind: report.detector,
      summary,
      evidence: [
        ...report.evidence,
        { pattern: report.pattern, nodeType: report.nodeType, retryCount: report.context?.retryCount },
      ],
      contextRef: `execution:${this.executionId}/node:${report.nodeId}`,
      allowedActions: [...allowedActions],
      deadlineAt: Date.now() + INCIDENT_DEADLINE_MS,
    }
  }

  private dispatch(incident: IncidentRecord, report: DiagnosisReport): void {
    // Already dispatched / waiting on a human: do not duplicate cards/wakes.
    if (incident.status !== "open") return

    const owner = this.getOwner()
    if (!owner) {
      // TODO(manual-queue-next-iteration): this is where an unowned incident
      // should enter the human/ops claim queue. This iteration only marks it
      // visible (`unowned`) and never pretends an agent is watching.
      this.store.markUnowned(incident.id)
      this.emit("incident_opened", incident.id, { status: "unowned" })
      return
    }

    const supervisor = this.supervisorFor(owner)
    this.store.markDispatched(incident.id, { kind: supervisor.kind, ref: owner.sessionId })
    this.emit("incident_opened", incident.id, { status: "dispatched" })

    void supervisor
      .notify(incident, { wake: incident.severity !== "info" })
      .catch((err) => {
      // Notification is best-effort: the incident stays open and visible.
      console.warn(
        `[RuntimeSupervisor] notify failed for ${incident.id}:`,
        err instanceof Error ? err.message : err,
      )
    })
    this.pipeline.markDecisionApplied(report, "harness_intervening", {
      incidentId: incident.id,
      status: "dispatched",
    })
  }

  private supervisorFor(owner: OwnerTarget): Supervisor {
    return owner.kind === "human" ? new HumanSupervisor(owner) : new ChatSupervisor(owner)
  }

  // ── Resolution ─────────────────────────────────────────────────────

  /**
   * Apply a decision. Idempotent: a second resolve on a terminal incident is a
   * no-op. Whitelist-checked against the incident's runtime-issued actions.
   */
  async resolve(
    incidentId: string,
    decision: Decision,
    source: "agent" | "user" | "policy",
  ): Promise<ResolveResult> {
    const record = this.store.findById(incidentId)
    if (!record) return { ok: false, detail: `事件 ${incidentId} 不存在`, status: "missing" }
    if (this.store.isTerminal(record.status)) {
      return { ok: true, detail: `事件已是终态（${record.status}），未重复处理`, status: record.status }
    }
    if (decision.type !== "escalate" && !record.allowedActions.includes(decision.type)) {
      return {
        ok: false,
        detail: `动作 ${decision.type} 不在允许列表（${record.allowedActions.join(", ")}）`,
        status: record.status,
      }
    }

    if (decision.type === "escalate") {
      return this.escalate(incidentId, decision.reason, decision.options ?? [])
    }

    // 1) Drive the public execution surface when the engine is no longer in a
    //    hook (paused after retries, failed, or terminal). 2) Otherwise stash an
    //    in-hook action for the live engine. Never both — a stale pending action
    //    would be consumed by the retry we just started.
    const execStatus = this.executionStatus()
    const needsOutOfBand = this.needsOutOfBand(execStatus, record)
    if (!needsOutOfBand) this.stash(record.nodeId, decision)

    let detail = "决策已记录，引擎下一个 hook 会消费"
    let ok = true

    if (needsOutOfBand && decision.type !== "proceed") {
      const applied = await this.actionExecutor.apply({
        executionId: this.executionId,
        workspaceId: this.workspaceId,
        nodeId: record.displayNodeId ?? record.nodeId,
        decision,
      })
      if (!applied.ok) {
        // Do not close the incident when the effect failed — the owner must be
        // able to try a different action or escalate.
        return { ok: false, detail: applied.detail, status: record.status }
      }
      detail = applied.detail
    }

    const resolved = this.store.resolve(incidentId, decision, source)
    if (!resolved) {
      return { ok: false, detail: "事件已被其他决策抢先处理", status: "resolved" }
    }
    this.applyNodeUi(record, decision)
    this.emit("incident_resolved", incidentId, { decision, source, detail })

    return { ok, detail, status: "resolved" }
  }

  async escalate(
    incidentId: string,
    reason: string,
    options: string[],
  ): Promise<ResolveResult> {
    const record = this.store.findById(incidentId)
    if (!record) return { ok: false, detail: `事件 ${incidentId} 不存在`, status: "missing" }
    if (this.store.isTerminal(record.status)) {
      return { ok: true, detail: `事件已是终态（${record.status}）`, status: record.status }
    }
    const owner = this.getOwner()
    this.store.markWaitingHuman(incidentId, owner?.sessionId ?? null)
    new HumanSupervisor(owner).notify({
      ...record,
      summary: `${record.summary}\n升级原因：${reason}`,
      evidence: [
        ...record.evidence,
        { options: options.length > 0 ? options : ["继续重试", "中止执行", "先暂停"] },
      ],
    }).catch(() => {})
    this.emit("incident_escalated", incidentId, { reason, options })
    return { ok: true, detail: "已在对话里请人确认", status: "waiting_human" }
  }

  private stash(nodeId: string, decision: Decision): void {
    switch (decision.type) {
      case "proceed":
        this.pendingRetry.delete(nodeId)
        break
      case "inject":
        this.pendingRetry.set(nodeId, { action: "retry", harnessHint: decision.message })
        break
      case "retry":
        this.pendingRetry.set(nodeId, {
          action: "retry",
          harnessHint: decision.hint,
          varPoolPatches: decision.varPoolPatches,
          modelOverride: decision.model,
        })
        break
      case "block":
        this.pendingRetry.set(nodeId, {
          action: "skip",
          continueSubsequent: decision.continueSubsequent ?? true,
        })
        this.pendingFailure.set(nodeId, {
          action: "continue",
          continueSubsequent: decision.continueSubsequent ?? true,
        })
        break
      case "abort":
        this.pendingRetry.set(nodeId, { action: "abort" })
        this.pendingFailure.set(nodeId, { action: "abort" })
        break
      case "pause":
        this.pendingFailure.set(nodeId, { action: "delegate" })
        break
      case "reload":
        // YAML replacement is always out-of-band (RepairService).
        break
      default:
        break
    }
  }

  private consumeRetry(nodeId: string): PendingRetryAction | null {
    const action = this.pendingRetry.get(nodeId)
    if (!action) return null
    this.pendingRetry.delete(nodeId)
    return action
  }

  private consumeFailure(nodeId: string): PendingFailureAction | null {
    const action = this.pendingFailure.get(nodeId)
    if (!action) return null
    this.pendingFailure.delete(nodeId)
    return action
  }

  private executionStatus(): string {
    try {
      const row = this.db
        .prepare("SELECT status FROM executions WHERE id = ?")
        .get(this.executionId) as { status?: string } | undefined
      return row?.status ?? "unknown"
    } catch {
      return "unknown"
    }
  }

  private needsOutOfBand(execStatus: string, record: IncidentRecord): boolean {
    if (execStatus === "paused" || execStatus === "failed") return true
    // Retry budget exhausted: the engine has already left the retry loop.
    if (record.phase === "failure_exhausted") return true
    if (execStatus === "running") return false
    return true
  }

  private applyNodeUi(record: IncidentRecord, decision: Decision): void {
    const report = this.lastReport.get(record.nodeId)
    if (!report) return
    const status =
      decision.type === "block"
        ? "harness_blocked"
        : decision.type === "proceed"
          ? "harness_modified"
          : "harness_modified"
    this.pipeline.markDecisionApplied(report, status, {
      decision: decision.type,
      incidentId: record.id,
    })
  }

  private emit(event: string, incidentId: string, extra: Record<string, unknown>): void {
    try {
      this.sse?.emit(this.sseWorkspaceId, {
        event,
        data: { executionId: this.executionId, incidentId, ...extra },
      })
    } catch {
      /* non-fatal */
    }
  }
}
