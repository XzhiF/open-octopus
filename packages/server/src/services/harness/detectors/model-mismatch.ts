// packages/server/src/services/harness/detectors/model-mismatch.ts
//
// ModelMismatchDetector — detects 400 errors indicating model capability mismatch.
// Matches patterns: /vision/, /tool not supported/, /model does not support/

import type { DiagnosisReport } from "@octopus/shared"
import { BaseDetector } from "../base-detector"
import type { HarnessCallbackEvent } from "../base-detector"

const MISMATCH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /vision/i, label: "vision" },
  { pattern: /tool not supported/i, label: "tool" },
  { pattern: /model does not support/i, label: "model_capability" },
  { pattern: /not support.*capability/i, label: "model_capability" },
  { pattern: /capability.*not.*support/i, label: "model_capability" },
]

export class ModelMismatchDetector extends BaseDetector {
  readonly name = "model_mismatch"

  observe(event: HarnessCallbackEvent): DiagnosisReport | null {
    if (event.type !== "agentEvent") return null

    const { nodeId, event: agentEvent } = event

    // Only look at error events
    if (agentEvent.type !== "error") return null

    // Only 400 errors indicate model mismatch
    const code = String(agentEvent.code ?? "")
    if (code !== "400") return null

    const message = agentEvent.message ?? ""

    // Check against mismatch patterns
    for (const { pattern, label } of MISMATCH_PATTERNS) {
      if (pattern.test(message)) {
        return {
          id: `diagnosis-model_mismatch-${nodeId}-${Date.now()}`,
          timestamp: Date.now(),
          detector: "model_mismatch",
          severity: "warning",
          executionId: "",  // filled by pipeline
          nodeId,
          nodeType: "agent",
          pattern: `model_mismatch:${label}`,
          evidence: [
            {
              errorCode: code,
              errorMessage: message,
            },
          ],
          context: {
            retryCount: 0,
            nodeDurationMs: 0,
            workflowProgress: 0,
          },
        }
      }
    }

    return null
  }
}
