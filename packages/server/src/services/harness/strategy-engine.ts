// packages/server/src/services/harness/strategy-engine.ts
//
// StrategyEngine — Layer 2 of the Harness.
// Matches DiagnosisReports against harness.yaml strategies and executes
// the matched strategy's intervention actions via the ActionRegistry.
// Falls back to Layer 3 (Agent Delegation) when no strategy matches or
// the matched strategy has delegate_to_agent: true.

import type {
  DiagnosisReport,
  StrategyConfig,
  StrategyAction,
  HarnessEvent,
  DelegationResult,
} from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import type { RepairService } from "../repair"
import type { DelegationContext } from "./agent-delegation"
import type { InterventionResult, ActionContext } from "./action-types"
import type { AgentDelegationService } from "./agent-delegation"
import { ActionRegistry } from "./action-registry"

/** Severity levels ordered from lowest to highest. */
const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
}

export interface StrategyEngineDeps {
  strategies: StrategyConfig[]
  dao: HarnessDAO
  sse: SSEService
  workspaceId: string
  repairService?: RepairService
  agentDelegationService?: AgentDelegationService
}

/**
 * Result of handling a DiagnosisReport through the StrategyEngine.
 */
export interface StrategyEngineResult {
  /** Whether Layer 3 Agent Delegation should take over. */
  delegate: boolean
  /**
   * Whether the synchronous domain should block the node (BP-5).
   * Only set for process_conflict + critical reports.
   */
  synchronousBlock?: boolean
  /** The matched strategy (null if no match and no wildcard). */
  matchedStrategy: StrategyConfig | null
  /** Results from executing each action in the matched strategy. */
  actionResults: InterventionResult[]
  /** Delegation result from Layer 3 (Harness Agent) if delegation occurred. */
  delegationResult?: DelegationResult
}

export class StrategyEngine {
  private strategies: StrategyConfig[]
  private dao: HarnessDAO
  private sse: SSEService
  private workspaceId: string
  private repairService?: RepairService
  private registry: ActionRegistry
  private agentDelegationService?: AgentDelegationService

  constructor(deps: StrategyEngineDeps) {
    this.strategies = deps.strategies
    this.dao = deps.dao
    this.sse = deps.sse
    this.workspaceId = deps.workspaceId
    this.repairService = deps.repairService
    this.registry = new ActionRegistry()
    this.agentDelegationService = deps.agentDelegationService
  }

  /**
   * Find the best-matching strategy for a DiagnosisReport.
   *
   * Matching rules:
   * 1. Exact match: strategy.match === report.detector
   * 2. Severity filter: if strategy.severity is set, report.severity must be >= strategy.severity
   * 3. Wildcard fallback: strategy.match === "*"
   * 4. No match: returns null (caller should delegate to Layer 3)
   */
  matchStrategy(report: DiagnosisReport): StrategyConfig | null {
    // First pass: look for exact match (with optional severity filter)
    for (const strategy of this.strategies) {
      if (strategy.match === report.detector) {
        if (this.severityMatches(report.severity, strategy.severity)) {
          return strategy
        }
      }
    }

    // Second pass: look for wildcard
    for (const strategy of this.strategies) {
      if (strategy.match === "*") {
        return strategy
      }
    }

    // No match found
    return null
  }

  /**
   * Execute all actions in a matched strategy.
   * Persists each action result to harness_events and emits SSE.
   */
  async executeActions(
    report: DiagnosisReport,
    strategy: StrategyConfig,
  ): Promise<InterventionResult[]> {
    const results: InterventionResult[] = []

    for (const actionDef of strategy.actions) {
      try {
        const result = await this.executeOneAction(report, actionDef)
        results.push(result)

        // Persist intervention event
        this.persistIntervention(report, actionDef, result)

        // Emit SSE event
        this.emitInterventionSSE(report, actionDef, result)
      } catch (err) {
        // One action failing should not crash the entire strategy
        const errorResult: InterventionResult = {
          success: false,
          action: typeof actionDef === 'string' ? actionDef : actionDef.type,
          error: err instanceof Error ? err.message : String(err),
        }
        results.push(errorResult)
      }
    }

    return results
  }

  /**
   * High-level method: tri-domain router.
   *
   * - process_conflict + critical → execute abort (sync block) + delegate
   * - Everything else → delegate to agent (no action execution)
   *
   * This is the primary entry point for the HarnessController/DetectorPipeline.
   */
  async handleReport(report: DiagnosisReport, delegationContext?: DelegationContext): Promise<StrategyEngineResult> {
    console.log(`[StrategyEngine] handleReport: detector=${report.detector}, severity=${report.severity}, hasContext=${!!delegationContext}`)
    if (delegationContext) {
      console.log(`[StrategyEngine] Context: varpool keys=${Object.keys(delegationContext.varpoolSnapshot).join(',')}, events=${delegationContext.recentEvents.length}`)
    }
    const isProcessConflict = report.detector === "process_conflict"
    const isCritical = report.severity === "critical"

    // ── Synchronous domain: process_conflict + critical ──────────────────
    // Delegate to agent FIRST — agent decides what to do (block/fix/proceed).
    // The caller (onBeforeNode) applies the decision synchronously.
    // No executeActions here — the agent's decision replaces the old abort flow.
    if (isProcessConflict && isCritical) {
      let delegationResult: DelegationResult | undefined
      if (this.agentDelegationService) {
        const result = await this.tryDelegate(report, delegationContext)
        if (result) {
          delegationResult = {
            success: result.success,
            decision: result.details?.decision ?? "block_node",
            varPoolPatches: result.details?.varPoolPatches,
            harnessHint: result.details?.harnessHint,
            modelOverride: result.details?.modelOverride,
            takeoverOutput: result.details?.takeoverOutput,
            blockReason: result.details?.blockReason,
            reasoning: result.details?.reasoning ?? result.message ?? "",
            tokenUsage: result.details?.tokenUsage,
          }
        }
      }

      return {
        delegate: true,
        synchronousBlock: true,
        matchedStrategy: this.matchStrategy(report),
        actionResults: [],
        delegationResult,
      }
    }

    // ── Async / pause domain: everything else → delegate ─────────────────
    let delegationResult: DelegationResult | undefined
    if (this.agentDelegationService) {
      const result = await this.tryDelegate(report, delegationContext)
      if (result) {
        delegationResult = {
          success: result.success,
          decision: result.details?.decision ?? "block_node",
          varPoolPatches: result.details?.varPoolPatches,
          harnessHint: result.details?.harnessHint,
          modelOverride: result.details?.modelOverride,
          takeoverOutput: result.details?.takeoverOutput,
          blockReason: result.details?.blockReason,
          reasoning: result.details?.reasoning ?? result.message ?? "",
          tokenUsage: result.details?.tokenUsage,
        }
      }
    }

    return {
      delegate: true,
      matchedStrategy: this.matchStrategy(report),
      actionResults: [],
      delegationResult,
    }
  }

  /**
   * Attempt Layer 3 delegation via AgentDelegationService.
   * Returns an InterventionResult or null if delegation service is unavailable.
   */
  private async tryDelegate(
    report: DiagnosisReport,
    delegationContext?: DelegationContext,
  ): Promise<InterventionResult | null> {
    if (!this.agentDelegationService) {
      return null
    }

    try {
      const delegationResult = await this.agentDelegationService.delegate({
        executionId: report.executionId,
        nodeId: report.nodeId,
        report,
        context: delegationContext ?? {
          recentEvents: [],
          varpoolSnapshot: {},
          nodeConfig: null,
          workflowContent: "",
        },
      })

      if (!delegationResult.success) {
        return {
          success: false,
          action: "agent_delegation",
          message: `Agent delegation failed: ${delegationResult.reasoning}`,
          delegate: true,
          details: {
            decision: delegationResult.decision ?? "block_node",
            reasoning: delegationResult.reasoning,
            blockReason: delegationResult.blockReason ?? delegationResult.reasoning,
            tokenUsage: delegationResult.tokenUsage,
          },
        }
      }

      return {
        success: true,
        action: "agent_delegation",
        message: `Agent delegation: ${delegationResult.decision} — ${(delegationResult.reasoning ?? "").slice(0, 100)}`,
        delegate: true,
        details: {
          decision: delegationResult.decision,
          reasoning: delegationResult.reasoning,
          varPoolPatches: delegationResult.varPoolPatches,
          harnessHint: delegationResult.harnessHint,
          modelOverride: delegationResult.modelOverride,
          takeoverOutput: delegationResult.takeoverOutput,
          blockReason: delegationResult.blockReason,
          tokenUsage: delegationResult.tokenUsage,
        },
      }
    } catch (err) {
      console.error("[StrategyEngine] Agent delegation error:", err)
      return {
        success: false,
        action: "agent_delegation",
        message: `Agent delegation error: ${err instanceof Error ? err.message : String(err)}`,
        delegate: true,
      }
    }
  }

  /**
   * Execute a single action using the ActionRegistry.
   */
  private async executeOneAction(
    report: DiagnosisReport,
    actionDef: StrategyAction,
  ): Promise<InterventionResult> {
    const ctx: ActionContext = {
      report,
      strategyAction: actionDef,
      dao: this.dao,
      sse: this.sse,
      repairService: this.repairService,
      workspaceId: this.workspaceId,
    }

    return this.registry.execute(ctx)
  }

  /**
   * Check if the report severity meets or exceeds the strategy's required severity.
   * If the strategy has no severity filter, any report severity matches.
   */
  private severityMatches(
    reportSeverity: string,
    strategySeverity?: string,
  ): boolean {
    if (!strategySeverity) return true
    const reportLevel = SEVERITY_ORDER[reportSeverity] ?? 0
    const strategyLevel = SEVERITY_ORDER[strategySeverity] ?? 0
    return reportLevel >= strategyLevel
  }

  /**
   * Persist an intervention result to the harness_events table.
   */
  private persistIntervention(
    report: DiagnosisReport,
    actionDef: StrategyAction,
    result: InterventionResult,
  ): void {
    const eventId = `intervention-${report.id}-${actionDef.type}-${Date.now()}`
    const row: HarnessEvent = {
      id: eventId,
      execution_id: report.executionId,
      node_id: report.nodeId,
      timestamp: Date.now(),
      event_type: "intervention",
      detector: report.detector,
      severity: report.severity,
      report_json: JSON.stringify(report),
      action_json: JSON.stringify(actionDef),
      result_json: JSON.stringify(result),
      token_usage_json: null,
      created_at: Math.floor(Date.now() / 1000),
    }

    try {
      this.dao.insertEvent(row)
    } catch (err) {
      console.error("[StrategyEngine] Failed to persist intervention event:", err)
    }
  }

  /**
   * Emit an SSE harness_intervention event.
   */
  private emitInterventionSSE(
    report: DiagnosisReport,
    actionDef: StrategyAction,
    result: InterventionResult,
  ): void {
    try {
      this.sse.emit(this.workspaceId, {
        event: "harness_intervention",
        data: {
          executionId: report.executionId,
          nodeId: report.nodeId,
          action: actionDef,
          result: result.message,
          success: result.success,
          modelOverride: result.modelOverride,
          harnessHint: result.harnessHint,
        },
      })
    } catch (err) {
      console.error("[StrategyEngine] Failed to emit SSE event:", err)
    }
  }

  /**
   * Emit harness_blocked SSE event and persist to harness_events when
   * a process_conflict diagnosis at critical severity executes an abort action.
   */
  private emitBlockedIfNeeded(
    report: DiagnosisReport,
    strategy: StrategyConfig,
    actionResults: InterventionResult[],
  ): void {
    const isProcessConflict = report.detector === "process_conflict"
    const isCritical = report.severity === "critical"
    const hasAbortAction = strategy.actions.some((a) => a.type === "abort")
    const abortSucceeded = actionResults.some(
      (r) => r.action === "abort" && r.success,
    )

    if (!isProcessConflict || !isCritical || !hasAbortAction || !abortSucceeded) {
      return
    }

    const blockedData = {
      executionId: report.executionId,
      nodeId: report.nodeId,
      reason: "Blocked by harness: process conflict",
      pattern: "process_conflict",
    }

    // Emit SSE harness_blocked event
    try {
      this.sse.emit(this.workspaceId, {
        event: "harness_blocked",
        data: blockedData,
      })
    } catch (err) {
      console.error("[StrategyEngine] Failed to emit harness_blocked SSE:", err)
    }

    // Persist blocked event to harness_events table
    try {
      const eventId = `blocked-${report.id}-${Date.now()}`
      const row: HarnessEvent = {
        id: eventId,
        execution_id: report.executionId,
        node_id: report.nodeId,
        timestamp: Date.now(),
        event_type: "blocked",
        detector: report.detector,
        severity: report.severity,
        report_json: JSON.stringify(report),
        action_json: null,
        result_json: JSON.stringify(blockedData),
        token_usage_json: null,
        created_at: Math.floor(Date.now() / 1000),
      }

      this.dao.insertEvent(row)
    } catch (err) {
      console.error("[StrategyEngine] Failed to persist blocked event:", err)
    }
  }
}
