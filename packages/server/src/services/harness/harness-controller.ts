// packages/server/src/services/harness/harness-controller.ts
//
// HarnessController — orchestrates the 3-layer Harness architecture:
//   Layer 1: DetectorPipeline (detect anomalies)
//   Layer 2: StrategyEngine (match strategies → actions) [future ticket]
//   Layer 3: AgentDelegation (complex scenarios) [future ticket]
//
// Currently implements Layer 1. Layers 2 and 3 are stubs that will be
// filled in by subsequent tickets (04-strategy-engine, 05-agent-delegation).

import type { HarnessSystemConfigParsed } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { HarnessConfigService } from "./config-service"
import { DetectorPipeline } from "./detector-pipeline"

export interface HarnessControllerDeps {
  dao: HarnessDAO
  sse: SSEService
  configService: HarnessConfigService
}

/**
 * HarnessController — one instance per server, manages per-execution pipelines.
 */
export class HarnessController {
  private dao: HarnessDAO
  private sse: SSEService
  private configService: HarnessConfigService

  /**
   * Active pipelines keyed by executionId.
   * Each execution gets its own DetectorPipeline with fresh detector instances.
   */
  private pipelines = new Map<string, DetectorPipeline>()

  constructor(deps: HarnessControllerDeps) {
    this.dao = deps.dao
    this.sse = deps.sse
    this.configService = deps.configService
  }

  /**
   * Called when a workflow execution starts.
   * Creates a fresh DetectorPipeline for the execution.
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
    },
  ): EngineCallbacks {
    // Clean up any existing pipeline for this execution (defensive)
    this.onExecutionEnd(executionId)

    const config = this.configService.loadMergedConfig()

    const pipeline = new DetectorPipeline({
      config,
      executionId,
      workspaceId,
      dao: this.dao,
      sse: this.sse,
      hostPid: opts?.hostPid ?? String(process.pid),
      hostPorts: opts?.hostPorts ?? [],
    })

    this.pipelines.set(executionId, pipeline)

    return pipeline.wrapCallbacks(originalCallbacks)
  }

  /**
   * Called when a workflow execution ends (completed, failed, cancelled).
   * Destroys the pipeline and its detectors.
   */
  onExecutionEnd(executionId: string): void {
    const pipeline = this.pipelines.get(executionId)
    if (pipeline) {
      pipeline.destroy()
      this.pipelines.delete(executionId)
    }
  }

  /**
   * Get the wrapped callbacks for an active execution.
   * Returns undefined if no pipeline exists for the execution.
   */
  getWrappedCallbacks(executionId: string): EngineCallbacks | undefined {
    const pipeline = this.pipelines.get(executionId)
    return pipeline ? undefined : undefined
    // The wrapped callbacks are returned from onExecutionStart.
    // This method exists for potential future use cases where
    // the controller needs to access an execution's pipeline.
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
  }
}
