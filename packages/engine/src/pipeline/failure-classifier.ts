import type { NodeExecutionResult } from "../executors/types"
import type { RetryOnCondition } from "@octopus/shared"

/**
 * Classifies node execution failures into retry condition categories.
 * Classification order matters — more specific checks come first.
 */
export class FailureClassifier {
  classify(result: NodeExecutionResult): RetryOnCondition {
    // Combine error field and logLines for comprehensive matching
    // This handles cases where executors put error messages in either location
    const allErrorText = [
      result.error ?? "",
      ...(result.logLines ?? []),
    ].join(" ")

    // 1. User cancelled (abort signal)
    if (result.status === "cancelled" || allErrorText.includes("Cancelled by user")) {
      return "user_cancelled"
    }

    // 2. Approval rejected
    if (result.status === "rejected") {
      return "approval_rejected"
    }

    // 3. Timeout — includes idle timeout errors
    if (
      result.timeout ||
      allErrorText.includes("timed out") ||
      allErrorText.includes("timeout") ||
      allErrorText.includes("idle")
    ) {
      return "timeout"
    }

    // 4. Non-zero exit code (bash/python)
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return "exit_code_nonzero"
    }

    // 5. Agent stream error
    if (
      allErrorText.includes("stream") ||
      allErrorText.includes("ECONNRESET") ||
      allErrorText.includes("Stream fracture")
    ) {
      return "agent_stream_error"
    }

    // 6. Config/expression error
    if (
      allErrorText.includes("Expression evaluation") ||
      allErrorText.includes("unexpected token") ||
      allErrorText.includes("SyntaxError")
    ) {
      return "config_error"
    }

    // 7. Agent partial completion — agent produced output before failing
    if (result.lastOutput && result.lastOutput.length > 0) {
      return "agent_partial_completion"
    }

    // 8. Transient error (network, resource, catch-all)
    return "transient_error"
  }
}
