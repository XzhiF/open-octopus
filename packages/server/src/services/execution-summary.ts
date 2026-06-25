import type { NodeExecutionResult } from "@octopus/engine"

/**
 * Format milliseconds to human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/**
 * Generate a natural language summary for a completed execution.
 * Rule-based MVP: no LLM required.
 */
export function generateSummary(
  workflowName: string,
  status: string,
  nodeResults: Record<string, NodeExecutionResult>,
  durationMs: number,
): string {
  const lines: string[] = []
  const totalNodes = Object.keys(nodeResults).length
  const completed = Object.values(nodeResults).filter(r => r.status === "completed").length
  const failed = Object.values(nodeResults).filter(r => r.status === "failed").length
  const skipped = Object.values(nodeResults).filter(r => r.status === "skipped" || r.status === "skipped_failed").length

  lines.push(
    `${workflowName} ${status === "completed" ? "completed successfully" : `ended with status: ${status}`}.`
  )
  lines.push(
    `${completed}/${totalNodes} nodes completed, ${failed} failed, ${skipped} skipped. Duration: ${formatDuration(durationMs)}.`
  )

  // Failed node details
  const failedNodes = Object.entries(nodeResults).filter(([_, r]) => r.status === "failed")
  if (failedNodes.length > 0) {
    lines.push(`Failed nodes:`)
    for (const [id, result] of failedNodes) {
      const errorSnippet =
        result.error?.slice(0, 100) ??
        result.logLines?.slice(-2).join(" ").slice(0, 100) ??
        "unknown error"
      lines.push(`  - ${id}: ${errorSnippet}`)
    }
  }

  // Unusually slow nodes (>3x average duration)
  const durations = Object.values(nodeResults).map(r => r.durationMs).filter(d => d > 0)
  if (durations.length > 0) {
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length
    const slowNodes = Object.entries(nodeResults)
      .filter(([_, r]) => r.durationMs > avgDuration * 3)
      .map(([id, r]) => `${id} (${formatDuration(r.durationMs)})`)
    if (slowNodes.length > 0) {
      lines.push(`Unusually slow nodes: ${slowNodes.join(", ")}`)
    }
  }

  // Token usage
  const totalTokens = Object.values(nodeResults).reduce(
    (sum, r) => sum + (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0),
    0
  )
  if (totalTokens > 0) {
    lines.push(`Total tokens used: ${totalTokens.toLocaleString()}`)
  }

  return lines.join("\n")
}
