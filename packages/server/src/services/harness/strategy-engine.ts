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
} from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import type { RepairService } from "../repair"
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
  /** The matched strategy (null if no match and no wildcard). */
  matchedStrategy: StrategyConfig | null
  /** Results from executing each action in the matched strategy. */
  actionResults: InterventionResult[]
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
      const result = await this.executeOneAction(report, actionDef)
      results.push(result)

      // Persist intervention event
      this.persistIntervention(report, actionDef, result)

      // Emit SSE event
      this.emitInterventionSSE(report, actionDef, result)
    }

    return results
  }

  /**
   * High-level method: match strategy, execute actions, determine delegation.
   * This is the primary entry point for the HarnessController/DetectorPipeline.
   *
   * When delegation is needed (no match or delegate_to_agent: true), calls
   * the AgentDelegationService (Layer 3) if available.
   */
  async handleReport(report: DiagnosisReport): Promise<StrategyEngineResult> {
    const matchedStrategy = this.matchStrategy(report)

    if (!matchedStrategy) {
      // No strategy matched → delegate to Layer 3
      const delegationResult = await this.tryDelegate(report)
      return {
        delegate: true,
        matchedStrategy: null,
        actionResults: delegationResult
          ? [delegationResult]
          : [],
      }
    }

    const actionResults = await this.executeActions(report, matchedStrategy)

    // Check if delegation is also needed after executing strategy actions
    if (matchedStrategy.delegate_to_agent === true) {
      const delegationResult = await this.tryDelegate(report)
      if (delegationResult) {
        actionResults.push(delegationResult)
      }
    }

    return {
      delegate: matchedStrategy.delegate_to_agent === true,
      matchedStrategy,
      actionResults,
    }
  }

  /**
   * Attempt Layer 3 delegation via AgentDelegationService.
   * Returns an InterventionResult or null if delegation service is unavailable.
   */
  private async tryDelegate(
    report: DiagnosisReport,
  ): Promise<InterventionResult | null> {
    if (!this.agentDelegationService) {
      return null
    }

    try {
      const delegationResult = await this.agentDelegationService.delegate({
        executionId: report.executionId,
        nodeId: report.nodeId,
        report,
        context: {
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
        }
      }

      return {
        success: true,
        action: "agent_delegation",
        message: `Agent delegation: ${delegationResult.interventionType} — ${delegationResult.reasoning.slice(0, 100)}`,
        delegate: true,
        details: {
          interventionType: delegationResult.interventionType,
          interventionData: delegationResult.interventionData,
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
}
