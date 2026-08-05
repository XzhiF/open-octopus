// packages/engine/src/executors/octopus-agent/task-prompt.ts
//
// Task Contract prompt builder for octopus_agent nodes.
// Generates structured markdown prompt from TaskContract + VarPool.
//

import type { TaskContract, HarnessConfig } from "@octopus/shared"
import type { VarPool } from "@octopus/shared"
import { substituteVarsFull } from "@octopus/shared"

/**
 * Build a structured markdown prompt from a TaskContract.
 *
 * Sections:
 * - Brief: Task description
 * - Context: Injected context items with variable substitution
 * - Constraints: List of constraints
 * - Expected Output: Output type and JSON schema
 * - Standard Operating Procedure: Step-by-step instructions
 * - Budget: Token/duration/cost limits
 * - Instructions: Execution guidelines with heartbeat interval
 *
 * @param task - TaskContract from octopus_agent node definition
 * @param pool - VarPool for variable substitution
 * @param nodeOutputs - Previous node outputs for $nodeId.output resolution
 * @param harness - Optional HarnessConfig for heartbeat interval
 * @returns Structured markdown prompt string
 */
export function buildTaskPrompt(
  task: TaskContract,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
  harness?: HarnessConfig,
): string {
  const parts: string[] = []
  const heartbeatInterval = harness?.heartbeat_interval ?? 3

  // Header
  parts.push("## Task Delegation")
  parts.push("")

  // Brief section (required)
  parts.push("### Brief")
  const briefText = substituteVarsFull(task.brief, pool, nodeOutputs)
  parts.push(briefText)
  parts.push("")

  // Context section (optional)
  if (task.context && task.context.length > 0) {
    parts.push("### Context")
    for (const contextItem of task.context) {
      const resolvedContext = substituteVarsFull(contextItem, pool, nodeOutputs)
      if (resolvedContext.trim()) {
        parts.push(resolvedContext)
      }
    }
    parts.push("")
  }

  // Constraints section (optional)
  if (task.constraints && task.constraints.length > 0) {
    parts.push("### Constraints")
    for (const constraint of task.constraints) {
      parts.push(`- ${constraint}`)
    }
    parts.push("")
  }

  // Expected Output section (optional)
  if (task.expected_output) {
    parts.push("### Expected Output")
    if (task.expected_output.type) {
      parts.push(`Type: ${task.expected_output.type}`)
    }
    if (task.expected_output.schema) {
      parts.push(`Schema: ${JSON.stringify(task.expected_output.schema, null, 2)}`)
    }
    parts.push("")
  }

  // Standard Operating Procedure section (optional)
  if (task.sop) {
    parts.push("### Standard Operating Procedure")
    parts.push(task.sop)
    parts.push("")
  }

  // Budget section (optional)
  if (task.budget) {
    parts.push("### Budget")
    if (task.budget.max_tokens !== undefined) {
      parts.push(`Max tokens: ${task.budget.max_tokens}`)
    }
    if (task.budget.max_duration !== undefined) {
      parts.push(`Max duration: ${task.budget.max_duration}s`)
    }
    if (task.budget.max_cost_usd !== undefined) {
      parts.push(`Max cost: $${task.budget.max_cost_usd}`)
    }
    parts.push("")
  }

  // Instructions section (always included)
  parts.push("### Instructions")
  parts.push("Execute this task according to the brief and SOP above.")
  parts.push(`- Report progress via heartbeat every ${heartbeatInterval} steps`)
  parts.push("- Return results as structured JSON matching the expected output schema")
  parts.push("- If you encounter blocking issues, include them in the heartbeat issues array")

  return parts.join("\n")
}
