// packages/shared/src/variables/substitute-full.ts
import { VarPool } from "./var-pool"
import { substituteVars } from "./substitute"
import { processConditionals } from "../notify/template-renderer"
import { applyFilters } from "../notify/filters"
import type { CrossExecResolver } from "./cross-exec-resolver"

/**
 * Full variable substitution pipeline for node prompts.
 * Combines: {{#if}} conditionals → ${var | filter} filters → $vars.xxx substitution.
 *
 * This brings the same template power from notify templates to node prompts
 * (agent, approval, bash, python executors).
 */
export function substituteVarsFull(
  text: string,
  pool: VarPool,
  nodeOutputs?: Record<string, Record<string, any>>,
  crossExecResolver?: CrossExecResolver,
  executionId?: string,
  loopContext?: Record<string, any>,
): string {
  // Step 1: process {{#if $vars.xxx}}...{{/if}} conditional blocks
  let result = processConditionals(text, pool, nodeOutputs)

  // Step 2: apply ${var | filter} expressions (default, truncate, duration, etc.)
  const filterVars: Record<string, string> = {}
  for (const [key, value] of Object.entries(pool.snapshot())) {
    filterVars[key] = String(value ?? "")
    if (key.startsWith("vars.")) filterVars[key.slice(5)] = String(value ?? "")
    if (key.startsWith("inputs.")) filterVars[key.slice(7)] = String(value ?? "")
    if (!key.includes(".")) filterVars[`vars.${key}`] = String(value ?? "")
  }
  if (nodeOutputs) {
    for (const [nodeId, outputs] of Object.entries(nodeOutputs)) {
      for (const [key, value] of Object.entries(outputs)) {
        filterVars[`${nodeId}.output.${key}`] = String(value ?? "")
      }
    }
  }
  result = applyFilters(result, filterVars)

  // Step 3: standard $vars.xxx / $inputs.xxx / $nodeId.output.xxx substitution
  result = substituteVars(result, pool, nodeOutputs, crossExecResolver, executionId, loopContext)

  return result
}
