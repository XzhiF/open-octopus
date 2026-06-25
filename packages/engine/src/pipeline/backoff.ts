import type { Backoff } from "@octopus/shared"

/**
 * Calculate backoff delay in seconds for a given attempt number.
 * attempt starts at 1 (first retry = second attempt).
 * Result includes ±10% jitter and is clamped to max_delay.
 */
export function calculateBackoff(policy: Backoff, attempt: number): number {
  let delay: number
  switch (policy.type) {
    case "fixed":
      delay = policy.initial_delay
      break
    case "exponential":
      delay = policy.initial_delay * Math.pow(policy.multiplier, attempt - 1)
      break
    case "linear":
      delay = policy.initial_delay + policy.increment * (attempt - 1)
      break
  }
  // ±10% jitter
  const jitter = delay * 0.1 * (Math.random() * 2 - 1)
  delay = Math.round(delay + jitter)
  return Math.min(delay, policy.max_delay)
}
