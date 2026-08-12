// packages/server/src/services/harness/detectors/stupid-retry.ts
//
// StupidRetryDetector — detects when a node retries N times with the same error.
// Per-node tracking: retry count + errorHash comparison.

import type { DiagnosisReport } from "@octopus/shared"
import { computeErrorHash } from "@octopus/shared"
import { BaseDetector } from "../base-detector"
import type { HarnessCallbackEvent } from "../base-detector"

interface NodeRetryState {
  retryCount: number
  lastErrorHash: string
  evidence: Array<{
    attempt: number
    errorHash: string
    errorMessage?: string
  }>
}

export interface StupidRetryConfig {
  threshold: number
}

export class StupidRetryDetector extends BaseDetector {
  readonly name = "stupid_retry"
  private nodeStates = new Map<string, NodeRetryState>()
  private threshold: number

  constructor(config: StupidRetryConfig) {
    super()
    this.threshold = config.threshold
  }

  observe(event: HarnessCallbackEvent): DiagnosisReport | null {
    if (event.type !== "nodeRetry") return null

    const { nodeId, attempt, result } = event

    if (!result) return null

    const errorHash = computeErrorHash(result)
    let state = this.nodeStates.get(nodeId)

    if (!state) {
      // First observation for this node
      state = {
        retryCount: 1,
        lastErrorHash: errorHash,
        evidence: [
          {
            attempt,
            errorHash,
            errorMessage: result.error,
          },
        ],
      }
      this.nodeStates.set(nodeId, state)
      return null
    }

    // Check if same error
    if (errorHash !== state.lastErrorHash) {
      // Different error — reset tracking for this node
      state.retryCount = 1
      state.lastErrorHash = errorHash
      state.evidence = [
        {
          attempt,
          errorHash,
          errorMessage: result.error,
        },
      ]
      return null
    }

    // Same error — increment
    state.retryCount++
    state.evidence.push({
      attempt,
      errorHash,
      errorMessage: result.error,
    })

    // Check threshold
    if (state.retryCount >= this.threshold) {
      const report: DiagnosisReport = {
        id: `diagnosis-stupid_retry-${nodeId}-${Date.now()}`,
        timestamp: Date.now(),
        detector: "stupid_retry",
        severity: "warning",
        executionId: "",  // filled by pipeline
        nodeId,
        nodeType: "",     // filled by pipeline if available
        pattern: "stupid_retry",
        evidence: state.evidence.map((e) => ({
          attempt: e.attempt,
          errorHash: e.errorHash,
          errorMessage: e.errorMessage,
        })),
        context: {
          retryCount: state.retryCount,
          nodeDurationMs: 0,
          workflowProgress: 0,
        },
      }

      // Reset state after triggering to avoid repeated reports
      this.nodeStates.delete(nodeId)

      return report
    }

    return null
  }

  override reset(): void {
    this.nodeStates.clear()
  }
}
