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
import { HarnessConfigService } from "./config-service"
import { DetectorPipeline } from "./detector-pipeline"
import { StrategyEngine } from "./strategy-engine"
import { AgentDelegationService } from "./agent-delegation"
import { HarnessAgentSession, type HarnessSessionContext } from "./harness-agent-session"

export interface HarnessControllerDeps {
  dao: HarnessDAO
  sse: SSEService
  configService: HarnessConfigService
  repairService?: RepairService
}

/**
 * HarnessController — one instance per server, manages per-execution pipelines.
 */
export class HarnessController {
  private dao: HarnessDAO
  private sse: SSEService
  private configService: HarnessConfigService
  private repairService?: RepairService

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
      session, // Pass session for context accumulation (AC3, AC4)
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
   */
  onExecutionEnd(executionId: string): void {
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
}
