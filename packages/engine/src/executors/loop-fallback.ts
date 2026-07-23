import type { VarPool } from "@octopus/shared"

/**
 * Extract $vars.xxx names that appear as LEFT operands of comparison operators
 * in a break_when / while expression.
 *
 * Why left-operand only: in `$vars.current >= $vars.total`, we want to
 * advance `current` (the progress counter), NOT `total` (the target).
 * Convention: variable-on-left, literal/target-on-right.
 *
 * Examples:
 *   "$vars.current_spec >= $vars.spec_count" → ["current_spec"]
 *   "$vars.found == true"                     → ["found"]
 *   "$vars.x >= 5 && $vars.y > 3"            → ["x", "y"]
 *   "true"                                    → []
 */
export function extractBreakWhenVars(expr: string): string[] {
  const re = /\$vars\.([a-zA-Z0-9_]+)\s*(?:>=|>|==|!=|<=|<)/g
  const vars: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(expr)) !== null) {
    vars.push(m[1])
  }
  return [...new Set(vars)]
}

export interface ForceAdvanceChange {
  key: string
  oldVal: unknown
  newVal: unknown
}

export interface ForceAdvanceResult {
  applied: boolean
  changes: ForceAdvanceChange[]
  skippedVars: string[]
}

/**
 * Force-advance loop condition variables that didn't change during this iteration.
 *
 * Strategy:
 *   - Numeric (number type): increment by 1
 *   - Numeric string (e.g., "3"): parse, increment, store back as string
 *   - undefined/null/"": skip — agent should explicitly initialize via vars_update.
 *     Auto-initializing to 1 corrupts non-numeric status vars (e.g.,
 *     requirements_checklist_status would become "1" instead of "COMPLETE").
 *     Empty string "" is also skipped because Number("") === 0 in JS,
 *     which would auto-increment to "1" and corrupt string-typed decision vars.
 *   - Non-numeric / already-changed: skip (returned in skippedVars)
 */
export function forceAdvanceLoopVars(
  pool: VarPool,
  breakWhenVars: string[],
  snapshotBefore: Map<string, unknown>,
): ForceAdvanceResult {
  const changes: ForceAdvanceChange[] = []
  const skippedVars: string[] = []

  for (const key of breakWhenVars) {
    const currentVal = pool.get(key)
    const beforeVal = snapshotBefore.get(key)

    // Agent DID update this variable — no fallback needed
    if (currentVal !== beforeVal) continue

  // undefined / null / "" — skip instead of auto-initializing.
    // Auto-init corrupts non-numeric status variables like
    // requirements_checklist_status that should be "COMPLETE" not "1".
    // Empty string "" is also skipped because Number("") === 0 in JS,
    // causing auto-increment to "1" which corrupts string-typed decision vars
    // like e2e_decision ("skip"/"retry") or clarify_decision ("proceed"/"revise").
    if (currentVal === undefined || currentVal === null || currentVal === "") {
      skippedVars.push(key)
      continue
    }

    // Try numeric increment
    const numVal = typeof currentVal === "number"
      ? currentVal
      : typeof currentVal === "string"
        ? Number(currentVal)
        : NaN

    if (!isNaN(numVal) && isFinite(numVal)) {
      const incremented = numVal + 1
      // Preserve original type: string "3" → "4", number 3 → 4
      const typedVal = typeof currentVal === "string" ? String(incremented) : incremented
      pool.set(key, typedVal)
      changes.push({ key, oldVal: currentVal, newVal: typedVal })
    } else {
      skippedVars.push(key)
    }
  }

  return { applied: changes.length > 0, changes, skippedVars }
}
