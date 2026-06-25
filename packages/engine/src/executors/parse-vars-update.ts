import type { VarPool } from "@octopus/shared"

/**
 * Extract and apply vars_update from agent/bash/python output text.
 *
 * Supports:
 * 1. Single-line JSON: {"vars_update":{"key":"value"}}
 * 2. Multi-line JSON inside markdown code fences: ```json\n{"vars_update":{...}}\n```
 * 3. Multi-line JSON without code fences (collects lines from {"vars_update" to closing }})
 *
 * Searches from the END of the output backwards (last vars_update wins).
 */
export function applyVarsUpdate(
  text: string,
  pool: VarPool,
  outputs: Record<string, any>,
): void {
  // Strategy 1: single-line JSON (existing behavior, fastest path)
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    const parsed = tryParse(line)
    if (parsed?.vars_update) {
      applyUpdate(parsed.vars_update, pool, outputs)
      return
    }
  }

  // Strategy 2: extract JSON from markdown code fences or multi-line blocks
  const extracted = extractVarsUpdateJson(text)
  if (extracted) {
    const parsed = tryParse(extracted)
    if (parsed?.vars_update) {
      applyUpdate(parsed.vars_update, pool, outputs)
    }
  }
}

/** Try to parse a string as JSON, return null on failure */
function tryParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** Apply the vars_update object to the pool and outputs */
function applyUpdate(
  varsUpdate: Record<string, any>,
  pool: VarPool,
  outputs: Record<string, any>,
): void {
  if (varsUpdate.__status) {
    outputs.__status = varsUpdate.__status
    delete varsUpdate.__status
  }
  pool.update(varsUpdate)
  outputs.vars_update = varsUpdate
}

/**
 * Extract the JSON string containing vars_update from text that may include
 * markdown code fences or multi-line JSON.
 */
function extractVarsUpdateJson(text: string): string | null {
  // Find the LAST occurrence of "vars_update" in the text
  const marker = '"vars_update"'
  const lastIdx = text.lastIndexOf(marker)
  if (lastIdx === -1) return null

  // Walk backwards from lastIdx to find the opening {
  let start = lastIdx
  while (start > 0 && text[start] !== "{") {
    start--
  }
  if (text[start] !== "{") return null

  // Walk forward to find the matching closing }
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}
