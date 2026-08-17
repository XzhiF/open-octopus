import type { JobDetailChild } from "@/lib/scheduler-api"

/** Lifecycle statuses that count as "in-flight" for a child subunit. A child in
 *  any of these states means the composite is still running. */
const IN_FLIGHT = new Set(["queued", "claimed", "running"])

/** Terminal non-success child statuses. */
const TERMINAL_FAIL = new Set(["failed", "aborted"])

/** Compute the parent aggregate status from children + parent (integration) status.
 *
 * Rules (ticket 13):
 *  - failed   if any child failed
 *  - aborted  if any child aborted
 *  - running  while any child is queued/claimed/running
 *  - done     when all children done AND parent done (integration complete)
 *  - otherwise the parent status (composition still in-flight, e.g. children not
 *    yet dispatched or integration node running)
 *
 * `failed` takes precedence over `aborted` and `running`.
 */
export function computeAggregateStatus(
  children: Pick<JobDetailChild, "status">[],
  parentStatus: string
): string {
  if (children.length === 0) return parentStatus

  const statuses = children.map((c) => c.status)

  if (statuses.some((s) => s === "failed")) return "failed"
  if (statuses.some((s) => s === "aborted")) return "aborted"
  if (statuses.some((s) => IN_FLIGHT.has(s))) return "running"
  if (statuses.every((s) => s === "done") && parentStatus === "done") return "done"

  return parentStatus
}

/** True when a child status is a non-terminal, in-flight state. Exposed for the
 *  events panel / cards to derive a "still running" badge without duplicating the
 *  set. */
export function isChildInFlight(status: string): boolean {
  return IN_FLIGHT.has(status)
}

/** True when a child status is a terminal failure. */
export function isChildTerminalFail(status: string): boolean {
  return TERMINAL_FAIL.has(status)
}
