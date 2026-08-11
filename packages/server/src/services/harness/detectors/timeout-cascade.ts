// packages/server/src/services/harness/detectors/timeout-cascade.ts
//
// TimeoutCascadeDetector — stateful detector that tracks consecutive node timeouts.
// Triggers when consecutiveTimeouts >= threshold.
// Resets on successful node completion.

import type { DiagnosisReport } from "@octopus/shared"
import { BaseDetector } from "../base-detector"
import type { HarnessCallbackEvent } from "../base-detector"

export interface TimeoutCascadeConfig {
  threshold: number
}

/**
 * Determine if a failed node_end event is a timeout.
 * Heuristic: error message contains "timeout" or durationMs >= 60000 with failed status.
 */
function isTimeoutEvent(event: Extract<HarnessCallbackEvent, { type: "nodeEnd" }>): boolean {
  const error = event.result?.error ?? ""
  if (/timeout/i.test(error)) return true

  // Check logLines for timeout indicators
  const logLines = event.result?.logLines ?? []
  for (const line of logLines) {
    if (/timed?\s*out/i.test(line)) return true
  }

  return false
}

export class TimeoutCascadeDetector extends BaseDetector {
  readonly name = "timeout_cascade"
  private consecutiveTimeouts = 0
  private recentTimeoutNodes: string[] = []
  private threshold: number

  constructor(config: TimeoutCascadeConfig) {
    super()
    this.threshold = config.threshold
  }

  observe(event: HarnessCallbackEvent): DiagnosisReport | null {
    if (event.type !== "nodeEnd") return null

    const { nodeId, status } = event

    // Success resets the chain
    if (status === "completed" || status === "success") {
      this.consecutiveTimeouts = 0
      this.recentTimeoutNodes = []
      return null
    }

    // Check if this failure is a timeout
    if (!isTimeoutEvent(event)) {
      // Non-timeout failure resets the chain
      this.consecutiveTimeouts = 0
      this.recentTimeoutNodes = []
      return null
    }

    // Timeout detected
    this.consecutiveTimeouts++
    this.recentTimeoutNodes.push(nodeId)

    // Check threshold
    if (this.consecutiveTimeouts >= this.threshold) {
      const report: DiagnosisReport = {
        id: `diagnosis-timeout_cascade-${nodeId}-${Date.now()}`,
        timestamp: Date.now(),
        detector: "timeout_cascade",
        severity: "critical",
        executionId: "",  // filled by pipeline
        nodeId,
        nodeType: event.nodeType ?? "",
        pattern: "timeout_cascade",
        evidence: this.recentTimeoutNodes.map((id) => ({
          nodeId: id,
          errorMessage: "timeout",
        })),
        context: {
          retryCount: 0,
          nodeDurationMs: event.durationMs,
          workflowProgress: 0,
          consecutiveCount: this.consecutiveTimeouts,
        },
      }

      // Reset after triggering to avoid repeated reports
      this.consecutiveTimeouts = 0
      this.recentTimeoutNodes = []

      return report
    }

    return null
  }

  override reset(): void {
    this.consecutiveTimeouts = 0
    this.recentTimeoutNodes = []
  }
}
