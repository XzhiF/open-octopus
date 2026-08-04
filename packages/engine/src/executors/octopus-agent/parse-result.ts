// packages/engine/src/executors/octopus-agent/parse-result.ts
//
// Structured result parser for octopus_agent nodes.
// Extracts StructuredResult JSON from agent output text.
//

import type { StructuredResult } from "@octopus/shared"

/**
 * Parse StructuredResult JSON from agent output text.
 *
 * Strategy:
 * 1. Look for JSON in code fences (```json ... ```)
 * 2. Try raw JSON without code fence
 * 3. Return null if no valid StructuredResult found
 *
 * @param text - Agent's final text output
 * @returns Parsed StructuredResult or null if not found/invalid
 */
export function parseStructuredResult(text: string): StructuredResult | null {
  if (!text || text.trim() === "") {
    return null
  }

  // Strategy 1: Extract JSON from code fences
  const codeFenceJson = extractJsonFromCodeFence(text)
  if (codeFenceJson) {
    const parsed = tryParseAsStructuredResult(codeFenceJson)
    if (parsed) return parsed
  }

  // Strategy 2: Try raw JSON (entire text)
  const rawJson = text.trim()
  if (rawJson.startsWith("{")) {
    const parsed = tryParseAsStructuredResult(rawJson)
    if (parsed) return parsed
  }

  // Strategy 3: Look for JSON object in text (multi-line extraction)
  const extractedJson = extractJsonObject(text)
  if (extractedJson) {
    const parsed = tryParseAsStructuredResult(extractedJson)
    if (parsed) return parsed
  }

  return null
}

/**
 * Extract JSON string from code fence block.
 * Looks for ```json ... ``` pattern.
 */
function extractJsonFromCodeFence(text: string): string | null {
  const regex = /```json\s*\n?([\s\S]*?)\n?```/g
  let match: RegExpExecArray | null

  // Find the LAST code fence (agent's final result)
  let lastMatch: string | null = null
  while ((match = regex.exec(text)) !== null) {
    lastMatch = match[1].trim()
  }

  return lastMatch
}

/**
 * Extract JSON object from text by finding opening { and matching closing }.
 * Handles nested braces and strings.
 */
function extractJsonObject(text: string): string | null {
  // Find the LAST occurrence of opening {
  let startIndex = -1
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "{") {
      startIndex = i
      break
    }
  }

  if (startIndex === -1) return null

  // Walk forward to find matching closing }
  let depth = 0
  let inString = false
  let escape = false

  for (let i = startIndex; i < text.length; i++) {
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
        return text.slice(startIndex, i + 1)
      }
    }
  }

  return null
}

/**
 * Try to parse a string as StructuredResult.
 * Validates that it has the minimum required fields.
 */
function tryParseAsStructuredResult(jsonString: string): StructuredResult | null {
  try {
    const parsed = JSON.parse(jsonString)

    // Validate minimum required fields for StructuredResult
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.status === "string" &&
      typeof parsed.summary === "string"
    ) {
      return parsed as StructuredResult
    }

    return null
  } catch {
    return null
  }
}
