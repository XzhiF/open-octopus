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

/**
 * Pure extraction: extract { summary, vars_update } from agent output text.
 * Used by the chat route for interaction completion — no VarPool needed.
 * Same battle-tested parsing logic as applyVarsUpdate.
 */
export function extractInteractionCompletion(text: string): {
  summary: string
  vars_update?: Record<string, any>
} | null {
  // Extract all code-fenced blocks
  const fences = extractAllCodeFences(text)

  // Strategy 1: Check the LAST code fence first — the agent's real completion
  // JSON is always in the final ```json ... ``` block. Earlier fences contain
  // examples from the system prompt or workflow YAML.
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse(fences[i].trim())
    if (parsed?.vars_update || parsed?.summary) {
      return {
        summary: parsed.summary ?? "",
        vars_update: parsed.vars_update,
      }
    }
    // Try multi-line JSON extraction inside this fence
    const extracted = extractVarsUpdateJson(fences[i])
    if (extracted) {
      const inner = tryParse(extracted)
      if (inner?.vars_update || inner?.summary) {
        return {
          summary: inner.summary ?? "",
          vars_update: inner.vars_update,
        }
      }
    }
  }

  // Strategy 2: Check plain text (outside code fences) for bare JSON
  const stripped = stripCodeFences(text)
  const lines = stripped.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    const parsed = tryParse(line)
    if (parsed?.vars_update || parsed?.summary) {
      return {
        summary: parsed.summary ?? "",
        vars_update: parsed.vars_update,
      }
    }
  }

  // Strategy 3: Multi-line JSON extraction on stripped text
  const extracted = extractVarsUpdateJson(stripped)
  if (extracted) {
    const parsed = tryParse(extracted)
    if (parsed?.vars_update || parsed?.summary) {
      return {
        summary: parsed.summary ?? "",
        vars_update: parsed.vars_update,
      }
    }
  }

  return null
}

/**
 * Extract content of all code-fenced blocks from text.
 * Returns an array of the text inside each ``` ... ``` block.
 */
function extractAllCodeFences(text: string): string[] {
  const results: string[] = []
  const regex = /```[^\n]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1])
  }
  return results
}

/**
 * Remove all code-fenced blocks from text.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "")
}
