// packages/server/src/services/harness/detector-pipeline.ts
//
// DetectorPipeline — Layer 1 of the Harness.
// Creates per-execution detector instances and wraps EngineCallbacks with a Proxy
// to intercept relevant events and route them to detectors.
// When a detector produces a DiagnosisReport, it is persisted to harness_events
// and emitted as an SSE event.

import type { DiagnosisReport, HarnessSystemConfigParsed } from "@octopus/shared"
import type { HarnessEvent } from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"
import { BaseDetector } from "./base-detector"
import type { HarnessCallbackEvent } from "./base-detector"
import { StupidRetryDetector } from "./detectors/stupid-retry"
import { ModelMismatchDetector } from "./detectors/model-mismatch"
import { ProcessConflictDetector } from "./detectors/process-conflict"
import { TimeoutCascadeDetector } from "./detectors/timeout-cascade"
import type { EngineCallbacks } from "@octopus/engine"

export interface DetectorPipelineDeps {
  config: HarnessSystemConfigParsed
  executionId: string
  workspaceId: string
  dao: HarnessDAO
  sse: SSEService
  hostPid?: string
  hostPorts?: string[]
}

export class DetectorPipeline {
  private detectors: BaseDetector[] = []
  private executionId: string
  private workspaceId: string
  private dao: HarnessDAO
  private sse: SSEService

  constructor(deps: DetectorPipelineDeps) {
    this.executionId = deps.executionId
    this.workspaceId = deps.workspaceId
    this.dao = deps.dao
    this.sse = deps.sse

    this.detectors = this.createDetectors(deps.config, deps.hostPid, deps.hostPorts)
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
   * This is the core dispatch method — called by the Proxy-wrapped callbacks.
   */
  routeEvent(event: HarnessCallbackEvent): void {
    for (const detector of this.detectors) {
      try {
        const report = detector.observe(event)
        if (report) {
          // Fill in executionId if not set
          if (!report.executionId) {
            report.executionId = this.executionId
          }
          this.handleDiagnosis(report)
        }
      } catch (err) {
        console.error(
          `[DetectorPipeline] Error in detector ${detector.name}:`,
          err,
        )
      }
    }
  }

  /**
   * Persist a DiagnosisReport to harness_events and emit SSE.
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
              pipeline.routeEvent({
                type: "nodeRetry",
                nodeId,
                attempt,
                maxAttempts,
                delayMs,
                result,
              })
              return original.call(target, nodeId, attempt, maxAttempts, delayMs)
            }

          case "onAgentEvent":
            return function (nodeId: string, event: any) {
              pipeline.routeEvent({ type: "agentEvent", nodeId, event })
              return original.call(target, nodeId, event)
            }

          case "onBeforeNode":
            return async function (
              nodeId: string,
              nodeType: string,
              nodeConfig: any,
            ) {
              pipeline.routeEvent({
                type: "beforeNode",
                nodeId,
                nodeType,
                nodeConfig,
              })
              return original.call(target, nodeId, nodeType, nodeConfig)
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
