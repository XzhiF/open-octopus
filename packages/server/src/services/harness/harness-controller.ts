// packages/server/src/services/harness/harness-controller.ts
//
// HarnessController — orchestrates the 3-layer Harness architecture:
//   Layer 1: DetectorPipeline (detect anomalies)
//   Layer 2: StrategyEngine (match strategies → actions)
//   Layer 3: AgentDelegation (complex scenarios)

import type { HarnessSystemConfigParsed } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import type { RepairService } from "../repair"
import type { EvolutionDAO } from "../../db/dao/evolution-dao"
import type { MemoryService } from "../agent/memory-service"
import type { SessionIntervention } from "./harness-agent-session"
import { HarnessConfigService } from "./config-service"
import { DetectorPipeline } from "./detector-pipeline"
import { StrategyEngine } from "./strategy-engine"
import { AgentDelegationService } from "./agent-delegation"
import { HarnessAgentSession, type HarnessSessionContext } from "./harness-agent-session"
import { getProvider as _getProvider } from "@octopus/providers"
import { getBuiltInCloneDir } from "../agent/paths"

export interface HarnessControllerDeps {
  dao: HarnessDAO
  sse: SSEService
  configService: HarnessConfigService
  repairService?: RepairService
  /** Optional: EvolutionDAO for recording harness experiences (ticket 03). */
  evolutionDao?: EvolutionDAO
  /** Optional: MemoryService for writing clone daily memory (ticket 03). */
  memoryService?: MemoryService
}

/**
 * HarnessController — one instance per server, manages per-execution pipelines.
 */
export class HarnessController {
  private dao: HarnessDAO
  private sse: SSEService
  private configService: HarnessConfigService
  private repairService?: RepairService
  private evolutionDao?: EvolutionDAO
  private memoryService?: MemoryService

  /**
   * Active pipelines keyed by executionId.
   * Each execution gets its own DetectorPipeline with fresh detector instances.
   */
  private pipelines = new Map<string, DetectorPipeline>()

  /**
   * Active agent sessions keyed by executionId.
   * Each execution gets its own HarnessAgentSession for context accumulation.
   * Created when session context is provided in onExecutionStart().
   */
  private sessions = new Map<string, HarnessAgentSession>()

  constructor(deps: HarnessControllerDeps) {
    this.dao = deps.dao
    this.sse = deps.sse
    this.configService = deps.configService
    this.repairService = deps.repairService
    this.evolutionDao = deps.evolutionDao
    this.memoryService = deps.memoryService
  }

  /**
   * Set or replace the repair service after construction.
   * Used to break the circular dependency: ExecutionService → ExecutionLifecycle
   * → HarnessController → RepairService → ExecutionService.
   */
  setRepairService(service: RepairService): void {
    this.repairService = service
  }

  /**
   * Called when a workflow execution starts.
   * Creates a fresh DetectorPipeline for the execution.
   * Optionally creates a HarnessAgentSession if session context is provided.
   *
   * @returns the wrapped callbacks to pass to the engine
   */
  onExecutionStart(
    executionId: string,
    workspaceId: string,
    originalCallbacks: EngineCallbacks,
    opts?: {
      hostPid?: string
      hostPorts?: string[]
      workspacePath?: string
      workflowContent?: string
      nodeList?: Array<{ id: string; type: string }>
      dependencyGraph?: Record<string, string[]>
      varpoolSnapshot?: Record<string, any>
    },
  ): EngineCallbacks {
    // Clean up any existing pipeline for this execution (defensive)
    this.onExecutionEnd(executionId)

    const config = this.configService.loadMergedConfig()

    // Create HarnessAgentSession if session context is provided (AC1, AC2)
    if (opts?.workflowContent && opts?.nodeList && opts?.dependencyGraph) {
      const sessionContext: HarnessSessionContext = {
        workflowContent: opts.workflowContent,
        nodeList: opts.nodeList,
        dependencyGraph: opts.dependencyGraph,
        varpoolSnapshot: opts.varpoolSnapshot ?? {},
        executionId,
      }
      const session = new HarnessAgentSession(sessionContext)
      this.sessions.set(executionId, session)
    }

    // Get the session (if created) to pass to AgentDelegationService
    const session = this.sessions.get(executionId)

    // Create the AgentDelegationService (Layer 3) for this execution
    const agentDelegationService = new AgentDelegationService({
      dao: this.dao,
      sse: this.sse,
      workspaceId,
      evolutionDao: this.evolutionDao, // Ticket 04: inject for success rate stats
      session, // Pass session for context accumulation (AC3, AC4)
      getProvider: (id: string) => _getProvider(id),
    })

    // Create a per-execution StrategyEngine with the current strategies
    const strategyEngine = new StrategyEngine({
      strategies: config.strategies,
      dao: this.dao,
      sse: this.sse,
      workspaceId,
      repairService: this.repairService,
      agentDelegationService,
    })

    const pipeline = new DetectorPipeline({
      config,
      executionId,
      workspaceId,
      workspacePath: opts?.workspacePath,
      dao: this.dao,
      sse: this.sse,
      hostPid: opts?.hostPid ?? String(process.pid),
      hostPorts: opts?.hostPorts ?? [],
      strategyEngine,
    })

    this.pipelines.set(executionId, pipeline)

    return pipeline.wrapCallbacks(originalCallbacks)
  }

  /**
   * Called when a workflow execution ends (completed, failed, cancelled).
   * Destroys the pipeline and its detectors.
   * Closes the agent session and writes harness_summary to executions table (AC5).
   * Records intervention experiences to the experiences table (ticket 03).
   * Updates intervention outcomes based on execution final status (ticket 04).
   *
   * @param executionId The execution that ended.
   * @param opts Optional execution outcome info for updating experience outcomes.
   */
  onExecutionEnd(
    executionId: string,
    opts?: { status: "completed" | "failed" | "cancelled"; lastFailedNodeId?: string },
  ): void {
    const pipeline = this.pipelines.get(executionId)
    if (pipeline) {
      pipeline.destroy()
      this.pipelines.delete(executionId)
    }

    // Close the agent session and write summary (AC5)
    const session = this.sessions.get(executionId)
    if (session) {
      try {
        session.close()
        const summary = session.getSummary()
        if (summary) {
          this.writeHarnessSummary(executionId, summary)
        }

        // Ticket 03: Record experiences for all interventions
        this.recordSessionExperiences(session, executionId)

        // Ticket 04: Update pending experience outcomes based on execution status
        if (opts) {
          this.updateExperienceOutcomes(executionId, opts)
        }

        // Ticket 03: Write clone daily memory
        this.writeCloneDailyMemory(session, executionId)
      } catch (err) {
        console.error(
          `[HarnessController] Error closing session for ${executionId}:`,
          err,
        )
      } finally {
        this.sessions.delete(executionId)
      }
    }
  }

  /**
   * Get the agent session for an active execution.
   * Returns undefined if no session was created for this execution.
   */
  getSession(executionId: string): HarnessAgentSession | undefined {
    return this.sessions.get(executionId)
  }

  /**
   * Get the pipeline for an active execution.
   * Useful for testing and for Layer 2/3 integration.
   */
  getPipeline(executionId: string): DetectorPipeline | undefined {
    return this.pipelines.get(executionId)
  }

  /**
   * Check if harness is active for a given execution.
   */
  isActive(executionId: string): boolean {
    return this.pipelines.has(executionId)
  }

  /**
   * Get the number of active pipelines (for testing).
   */
  get activePipelineCount(): number {
    return this.pipelines.size
  }

  /**
   * Destroy all active pipelines. Called on server shutdown.
   */
  destroyAll(): void {
    for (const [executionId, pipeline] of this.pipelines) {
      try {
        pipeline.destroy()
      } catch (err) {
        console.error(
          `[HarnessController] Error destroying pipeline for ${executionId}:`,
          err,
        )
      }
    }
    this.pipelines.clear()

    // Close all sessions without writing summaries (shutdown path)
    for (const [executionId, session] of this.sessions) {
      try {
        if (!session.isClosed) {
          session.close()
        }
      } catch (err) {
        console.error(
          `[HarnessController] Error closing session for ${executionId}:`,
          err,
        )
      }
    }
    this.sessions.clear()
  }

  /**
   * Write the harness summary to the executions table.
   * Updates both harness_status and harness_summary columns.
   */
  private writeHarnessSummary(
    executionId: string,
    summary: { totalInterventions: number; decisions: any[]; harnessStatus: string },
  ): void {
    try {
      const db = this.dao.getDb()
      db.prepare(`
        UPDATE executions
        SET harness_status = ?, harness_summary = ?
        WHERE id = ?
      `).run(summary.harnessStatus, JSON.stringify(summary), executionId)
    } catch (err) {
      console.error(
        `[HarnessController] Failed to write harness_summary for ${executionId}:`,
        err,
      )
    }
  }

  /**
   * Record experiences for all interventions in the session.
   * Each intervention becomes an experience row with scope='harness'.
   * Ticket 03 — AC-1, AC-2, AC-3, AC-6.
   */
  private recordSessionExperiences(
    session: HarnessAgentSession,
    executionId: string,
  ): void {
    if (!this.evolutionDao) {
      // No DAO configured — skip experience recording (non-fatal)
      return
    }

    const interventions = session.getInterventions()
    if (interventions.length === 0) {
      return
    }

    const timestamp = new Date().toISOString()
    const org = "default" // Harness agent uses default org

    for (const intervention of interventions) {
      try {
        const experienceRow = this.buildExperienceRow(intervention, executionId, org, timestamp)
        this.evolutionDao.insertExperienceV2(experienceRow)
      } catch (err) {
        console.error(
          `[HarnessController] Failed to record experience for node ${intervention.nodeId}:`,
          err,
        )
      }
    }
  }

  /**
   * Build an ExperienceRowV2 from an intervention.
   * Ticket 03 — AC-2, AC-3, AC-6.
   */
  private buildExperienceRow(
    intervention: SessionIntervention,
    executionId: string,
    org: string,
    timestamp: string,
  ): Omit<import("../../db/types").ExperienceRowV2, "id"> {
    const { nodeId, report, decision, reason } = intervention

    // Build structured content: detector + pattern + decision + reasoning
    const content = this.buildExperienceContent(report, decision, reason)

    // Build pattern tags: [decision, pattern, nodeType, severity]
    const patternTags = [
      decision,
      report.pattern,
      report.nodeType,
      report.severity,
    ]

    return {
      skill_name: `harness-${report.detector}`,
      content,
      source_session_id: null,
      org,
      created_at: timestamp,
      scope: "harness",
      scope_ref: report.detector,
      pattern_tags: JSON.stringify(patternTags),
      outcome: JSON.stringify({ label: "pending" }),
      source_type: "harness",
      execution_id: executionId,
      node_id: nodeId,
    }
  }

  /**
   * Build a searchable experience content string from an intervention.
   * Includes detector, pattern, decision, reasoning, and node information.
   * Ticket 03 — AC-6.
   */
  private buildExperienceContent(
    report: import("@octopus/shared").DiagnosisReport,
    decision: string,
    reason: string,
  ): string {
    const lines = [
      `## Harness Intervention Summary`,
      ``,
      `**Detector**: ${report.detector}`,
      `**Pattern**: ${report.pattern}`,
      `**Severity**: ${report.severity}`,
      `**Node**: ${report.nodeId} (${report.nodeType})`,
      `**Decision**: ${decision}`,
      `**Reasoning**: ${reason}`,
      ``,
      `### Evidence`,
    ]

    // Add evidence details
    for (const evidence of report.evidence) {
      const parts: string[] = []
      if (evidence.attempt !== undefined) parts.push(`attempt ${evidence.attempt}`)
      if (evidence.errorCode) parts.push(`code: ${evidence.errorCode}`)
      if (evidence.errorMessage) parts.push(`error: ${evidence.errorMessage}`)
      lines.push(`- ${parts.join(", ") || JSON.stringify(evidence)}`)
    }

    return lines.join("\n")
  }

  /**
   * Update pending experience outcomes based on the execution's final status.
   * Ticket 04 — AC-1, AC-2, AC-3.
   *
   * Rules:
   * - completed → all interventions get outcome.label = 'success'
   * - failed → last failed node's intervention gets 'failed', all others get 'success'
   * - cancelled → all interventions stay as 'pending' (no update)
   */
  private updateExperienceOutcomes(
    executionId: string,
    opts: { status: "completed" | "failed" | "cancelled"; lastFailedNodeId?: string },
  ): void {
    if (!this.evolutionDao) {
      return // No DAO — skip (non-fatal)
    }

    // Only update for completed or failed executions
    if (opts.status === "cancelled") {
      return // Keep pending outcomes for cancelled executions
    }

    try {
      // Find all pending experiences for this execution
      const pendingExperiences = this.evolutionDao.listByExecutionId(executionId, {
        outcomeLabel: "pending",
      })

      if (pendingExperiences.length === 0) {
        return
      }

      if (opts.status === "completed") {
        // AC-2: All interventions marked as success
        for (const exp of pendingExperiences) {
          this.evolutionDao.updateOutcome(
            exp.id,
            JSON.stringify({ label: "success" }),
          )
        }
      } else if (opts.status === "failed") {
        // AC-3: Last failed node → 'failed', all others → 'success'
        const lastFailedNodeId = opts.lastFailedNodeId
        for (const exp of pendingExperiences) {
          const isLastFailed = exp.node_id === lastFailedNodeId
          const outcomeLabel = isLastFailed ? "failed" : "success"
          this.evolutionDao.updateOutcome(
            exp.id,
            JSON.stringify({ label: outcomeLabel }),
          )
        }
      }
    } catch (err) {
      console.error(
        `[HarnessController] Failed to update experience outcomes for ${executionId}:`,
        err,
      )
    }
  }

  /**
   * Write clone daily memory summarizing all interventions.
   * Ticket 03 — AC-4.
   */
  private writeCloneDailyMemory(
    session: HarnessAgentSession,
    executionId: string,
  ): void {
    if (!this.memoryService) {
      // No memory service configured — skip daily memory write (non-fatal)
      return
    }

    const interventions = session.getInterventions()
    if (interventions.length === 0) {
      return
    }

    try {
      const content = this.buildDailyMemoryContent(interventions, executionId)
      const sessionId = `harness-${executionId}`
      const cloneDir = getBuiltInCloneDir("harness-agent")

      this.memoryService.recordDaily("default", content, sessionId, cloneDir)
    } catch (err) {
      console.error(
        `[HarnessController] Failed to write clone daily memory for ${executionId}:`,
        err,
      )
    }
  }

  /**
   * Build daily memory content summarizing all interventions.
   */
  private buildDailyMemoryContent(
    interventions: SessionIntervention[],
    executionId: string,
  ): string {
    const lines = [
      `## Harness Execution ${executionId}`,
      ``,
      `Total interventions: ${interventions.length}`,
      ``,
    ]

    for (const intervention of interventions) {
      lines.push(`### Node: ${intervention.nodeId}`)
      lines.push(`- Detector: ${intervention.report.detector}`)
      lines.push(`- Pattern: ${intervention.report.pattern}`)
      lines.push(`- Severity: ${intervention.report.severity}`)
      lines.push(`- Decision: ${intervention.decision}`)
      lines.push(`- Reasoning: ${intervention.reason}`)
      lines.push(``)
    }

    return lines.join("\n")
  }
}
