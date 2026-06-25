import type { RetryConfig, RetryPolicy, RetryOnCondition } from "@octopus/shared"
import { globMatch } from "./glob"

/**
 * Resolves the retry policy for a given node ID.
 * Priority: exact match > glob match (by specificity) > default.
 */
export class RetryPolicyResolver {
  constructor(private config: RetryConfig) {}

  resolve(nodeId: string): RetryPolicy {
    // 1. Exact match
    if (this.config.overrides[nodeId]) {
      return this.mergePolicy(this.config.overrides[nodeId])
    }

    // 2. Glob match — sort by specificity (non-wildcard char count desc)
    const matches = Object.entries(this.config.overrides)
      .filter(([pattern]) => globMatch(pattern, nodeId))
      .sort((a, b) => {
        const specA = a[0].replace(/[*?]/g, "").length
        const specB = b[0].replace(/[*?]/g, "").length
        return specB - specA
      })

    if (matches.length > 0) {
      return this.mergePolicy(matches[0][1])
    }

    // 3. Default
    return this.config.default
  }

  private mergePolicy(override: Partial<RetryPolicy>): RetryPolicy {
    return {
      max_attempts: override.max_attempts ?? this.config.default.max_attempts,
      backoff: override.backoff ?? this.config.default.backoff,
      max_total_duration: override.max_total_duration ?? this.config.default.max_total_duration,
      retry_on: this.mergeArrayField(override.retry_on, this.config.default.retry_on),
      never_retry_on: this.mergeArrayField(override.never_retry_on, this.config.default.never_retry_on),
    }
  }

  /**
   * Merge array fields with append syntax support.
   * If any element starts with "+", it's appended to the default array.
   * Otherwise, the override completely replaces the default.
   *
   * Example:
   *   default: ["exit_code_nonzero", "timeout"]
   *   override: ["+agent_partial_completion"]
   *   result: ["exit_code_nonzero", "timeout", "agent_partial_completion"]
   */
  private mergeArrayField(
    override: string[] | undefined,
    defaultValue: RetryOnCondition[]
  ): RetryOnCondition[] {
    if (!override) return defaultValue

    // Check if any element uses append syntax
    const hasAppend = override.some(item => item.startsWith("+"))
    if (!hasAppend) return override as RetryOnCondition[]

    // Append syntax: start with defaults, add non-plus items
    const result: RetryOnCondition[] = [...defaultValue]
    for (const item of override) {
      if (item.startsWith("+")) {
        const value = item.slice(1) as RetryOnCondition
        if (value && !result.includes(value)) {
          result.push(value)
        }
      } else {
        // Non-plus items in append mode are treated as literals
        const value = item as RetryOnCondition
        if (!result.includes(value)) {
          result.push(value)
        }
      }
    }
    return result
  }
}
