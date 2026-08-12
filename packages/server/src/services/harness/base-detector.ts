// packages/server/src/services/harness/base-detector.ts
//
// BaseDetector — abstract base class for all harness detectors.
// Each execution gets fresh detector instances (per-execution lifecycle).
// Detectors observe HarnessCallbackEvents and optionally produce DiagnosisReports.

import type { DiagnosisReport } from "@octopus/shared"

/**
 * HarnessCallbackEvent — discriminated union of events routed to detectors.
 * These mirror the relevant EngineCallbacks but are simplified for detector consumption.
 */
export type HarnessCallbackEvent =
  | {
      type: "nodeStart"
      nodeId: string
      nodeType: string
    }
  | {
      type: "nodeEnd"
      nodeId: string
      status: string
      durationMs: number
      result?: {
        logLines?: string[]
        error?: string
        outputs?: { exitCode?: number; [key: string]: any }
        [key: string]: any
      }
      nodeType?: string
    }
  | {
      type: "nodeRetry"
      nodeId: string
      attempt: number
      maxAttempts: number
      delayMs: number
      result?: {
        logLines?: string[]
        error?: string
        outputs?: { exitCode?: number; [key: string]: any }
        [key: string]: any
      }
    }
  | {
      type: "agentEvent"
      nodeId: string
      event: {
        type: string
        code?: string
        message?: string
        content?: string
        [key: string]: any
      }
    }
  | {
      type: "beforeNode"
      nodeId: string
      nodeType: string
      nodeConfig: {
        bash?: string
        python?: string
        script?: string
        [key: string]: any
      }
    }
  | {
      type: "error"
      nodeId: string
      error: string
    }

/**
 * BaseDetector — all detectors extend this class.
 *
 * Lifecycle:
 * - Constructed per-execution by DetectorPipeline
 * - observe() is called for every routed event
 * - reset() is called at execution start (for stateful detectors)
 * - destroy() is called at execution end (cleanup resources)
 */
export abstract class BaseDetector {
  abstract readonly name: string

  /**
   * Observe an event and optionally produce a DiagnosisReport.
   * Return null if the event is not relevant or no anomaly is detected.
   */
  abstract observe(event: HarnessCallbackEvent): DiagnosisReport | null

  /**
   * Reset internal state. Called at execution start.
   * Override for stateful detectors.
   */
  reset(): void {}

  /**
   * Cleanup resources. Called at execution end.
   * Override if the detector holds external resources.
   */
  destroy(): void {}
}
