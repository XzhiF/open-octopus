import type { ExpertResult } from "./swarm-types"

export type FailurePolicy = "fail_fast" | "continue_partial" | "retry_failed"

export class FailureHandler {
  constructor(private policy: FailurePolicy) {}

  /** Determine what to do when an expert fails */
  handleFailure(
    failedExpert: string,
    allResults: ExpertResult[],
  ): { shouldStop: boolean; action: "stop" | "continue" | "retry" } {
    switch (this.policy) {
      case "fail_fast":
        return { shouldStop: true, action: "stop" }
      case "continue_partial":
        return { shouldStop: false, action: "continue" }
      case "retry_failed":
        return { shouldStop: false, action: "retry" }
    }
  }

  /** Check if a downstream expert should be skipped due to upstream failure */
  shouldSkip(
    expert: { role: string; depends_on?: string[] },
    results: ExpertResult[],
  ): { skip: boolean; reason?: string } {
    if (!expert.depends_on) return { skip: false }

    for (const dep of expert.depends_on) {
      const depResult = results.find(r => r.role === dep)
      if (depResult && (depResult.status === "failed" || depResult.status === "skipped")) {
        return { skip: true, reason: `Dependency "${dep}" ${depResult.status}` }
      }
    }
    return { skip: false }
  }

  /** Get default policy for a mode */
  static defaultPolicy(mode: string): FailurePolicy {
    return mode === "dispatch" ? "fail_fast" : "continue_partial"
  }
}
