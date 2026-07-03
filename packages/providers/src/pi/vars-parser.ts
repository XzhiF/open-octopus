/**
 * Extract vars_update from text output with progressive fallback.
 * 1. Direct JSON.parse
 * 2. Regex extract from code blocks or vars_update patterns
 * 3. Shallow regex for flat vars_update object
 * 4. Return empty + warn
 */
export function parseVarsUpdate(text: string): Record<string, unknown> {
  if (!text) return {}

  // Strategy 1: direct parse
  try {
    const parsed = JSON.parse(text)
    return extractVars(parsed)
  } catch { /* continue */ }

  // Strategy 2: extract JSON block from markdown or surrounding text
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    ?? text.match(/(\{[\s\S]*"vars_update"[\s\S]*\})/)
  if (jsonBlock) {
    try { return extractVars(JSON.parse(jsonBlock[1].trim())) } catch { /* continue */ }
  }

  // Strategy 3: shallow regex for flat vars_update
  const varsMatch = text.match(/"vars_update"\s*:\s*(\{[^}]*\})/)
  if (varsMatch) {
    try { return JSON.parse(varsMatch[1]) } catch { /* continue */ }
  }

  // Strategy 4: degraded
  if (text.includes('vars_update')) {
    console.warn('[vars-parser] Failed to parse vars_update from output')
  }
  return {}
}

function extractVars(obj: any): Record<string, unknown> {
  if (obj && typeof obj === 'object' && 'vars_update' in obj) {
    const v = obj.vars_update
    return (v && typeof v === 'object') ? v : {}
  }
  return {}
}
