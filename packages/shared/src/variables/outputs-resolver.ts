// packages/shared/src/variables/outputs-resolver.ts
//
// Shared outputs mapping resolver.
// Used by both the real engine executors (bash, python, agent, approval)
// and the simulator to resolve node `outputs:` mapping expressions.

import { VarPool } from "./var-pool"
import { evaluateExpression } from "./expression"
import { substituteVars } from "./substitute"

/**
 * Regex matching `$vars.key = expression` assignment syntax.
 * Captures: (1) variable key, (2) right-hand side expression.
 */
const VARS_ASSIGN_RE = /^\$vars\.(\w+)\s*=\s*(.+)$/

/**
 * Regex matching simple `$vars.key` reference (no assignment).
 */
const VARS_REF_RE = /^\$vars\.(\w+)$/

/**
 * Resolve a single expression in a node's `outputs:` mapping.
 *
 * Resolution order:
 * 1. `$last_output` → lastOutput
 * 2. `$last_output.field` → JSON.parse(lastOutput) → .field
 * 3. `$exit_code` → exitCode
 * 4. `$vars.x = expr` → evaluateExpression(rhs, pool)
 * 5. `$vars.xxx` → pool.get(key)
 * 6. starts with `$` → substituteVars(expr, pool)
 * 7. literal string
 *
 * @param expr - The expression string from outputs mapping
 * @param pool - VarPool for reading/writing variables
 * @param lastOutput - The node's lastOutput (stdout for bash/python, text for agent)
 * @param exitCode - The node's exit code (bash/python only, undefined for others)
 * @returns The resolved value
 */
export function resolveOutputsExpression(
  expr: string,
  pool: VarPool,
  lastOutput: string | undefined,
  exitCode: number | undefined,
): unknown {
  // 1. Direct $last_output reference
  if (expr === "$last_output") {
    return lastOutput
  }

  // 2. $last_output.field — JSON.parse lastOutput, extract field
  if (expr.startsWith("$last_output.")) {
    const field = expr.slice(13) // length of "$last_output."
    let obj: any = lastOutput
    try {
      obj = JSON.parse(lastOutput as string)
    } catch {
      // stdout is not valid JSON — return undefined
      return undefined
    }
    return obj?.[field]
  }

  // 3. Direct $exit_code reference
  if (expr === "$exit_code") {
    return exitCode
  }

  // 4. $vars.x = expr — evaluateExpression for arithmetic/boolean
  const assignMatch = expr.match(VARS_ASSIGN_RE)
  if (assignMatch) {
    const rhs = assignMatch[2].trim()
    return evaluateExpression(rhs, pool)
  }

  // 5. $vars.xxx — direct pool reference
  const refMatch = expr.match(VARS_REF_RE)
  if (refMatch) {
    return pool.get(refMatch[1])
  }

  // 6. Other $-prefixed expressions — substituteVars
  if (expr.startsWith("$")) {
    return substituteVars(expr, pool)
  }

  // 7. Literal string
  return expr
}

/**
 * Process a node's full `outputs:` mapping block.
 * Iterates over all key-value pairs, resolves each expression,
 * writes resolved values to VarPool and the outputs record.
 *
 * @param nodeOutputs - The node's outputs mapping (from YAML `outputs:` block)
 * @param outputs - Mutable record to populate with resolved values
 * @param pool - VarPool for reading/writing variables
 * @param lastOutput - Node's lastOutput
 * @param exitCode - Node's exit code
 * @returns Record of resolved key-value pairs (same object as `outputs`, augmented)
 */
export function applyOutputsMapping(
  nodeOutputs: Record<string, string>,
  outputs: Record<string, any>,
  pool: VarPool,
  lastOutput: string | undefined,
  exitCode: number | undefined,
): Record<string, any> {
  for (const [key, expr] of Object.entries(nodeOutputs)) {
    // Strip $vars. prefix — consistent across all executors
    const poolKey = key.startsWith("$vars.") ? key.slice(6) : key

    // Handle $vars.x = expr assignment specially: extract the target var key
    const assignMatch = expr.match(VARS_ASSIGN_RE)
    if (assignMatch) {
      const varKey = assignMatch[1]
      const resolved = resolveOutputsExpression(expr, pool, lastOutput, exitCode)
      pool.set(varKey, resolved)
      outputs[poolKey] = resolved
      continue
    }

    const resolved = resolveOutputsExpression(expr, pool, lastOutput, exitCode)
    pool.set(poolKey, resolved)
    outputs[poolKey] = resolved
  }

  return outputs
}
