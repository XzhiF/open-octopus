// packages/shared/src/notify/filters.ts

type FilterVars = Record<string, string>

/**
 * Apply ${var | filter} syntax to text.
 * Supported filters: duration, truncate:N, default:value, upper, lower
 *
 * Handles nested ${} in filter arguments (e.g. ${a | default:${b | default:x}})
 * by splitting at the first top-level colon (outside nested braces) and recursively
 * resolving the default filter's fallback value.
 */
export function applyFilters(text: string, vars: FilterVars): string {
  // Resolve innermost ${...|...} first (no nested braces inside),
  // then repeat until no more filter expressions remain.
  // This correctly handles ${a | default:${b | default:x}} by resolving
  // ${b | default:x} first, then ${a | default:x}.
  const innerPattern = /\$\{([^{}|]+)\s*\|\s*([^{}]+)\}/g
  const MAX_ITERATIONS = 10
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const prev = text
    text = text.replace(innerPattern, (_match, varExpr: string, filterExpr: string) => {
      return resolveFilter(varExpr.trim(), filterExpr.trim(), vars)
    })
    if (text === prev || !text.includes("${")) break
  }
  return text
}

/**
 * Resolve a single filter expression (varExpr | filterExpr).
 * For the "default" filter, recursively resolves nested ${} in the fallback.
 */
function resolveFilter(key: string, filterExpr: string, vars: FilterVars): string {
  const value = vars[key] ?? ""
  const [filterName, filterArg] = splitAtTopLevelColon(filterExpr)

  switch (filterName) {
    case "duration":
      return formatDuration(value)
    case "truncate": {
      const maxLen = parseInt(filterArg, 10) || 100
      return value.length > maxLen ? value.slice(0, maxLen) + "..." : value
    }
    case "default": {
      if (value.length > 0) return value
      // Recursively resolve nested ${} in fallback value
      return applyFilters(filterArg, vars)
    }
    case "upper":
      return value.toUpperCase()
    case "lower":
      return value.toLowerCase()
    default:
      return `$\{${key} | ${filterExpr}}` // Unknown filter — preserve original
  }
}

/**
 * Split a filter expression at the first colon that is NOT inside nested ${}.
 * Returns [filterName, filterArg]. If no top-level colon found, filterArg is "".
 *
 * Example:
 *   "default:${hook.error | default:未提供}"
 *   → ["default", "${hook.error | default:未提供}"]
 *
 *   "truncate:100"
 *   → ["truncate", "100"]
 */
function splitAtTopLevelColon(str: string): [string, string] {
  let depth = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === "$" && str[i + 1] === "{") depth++
    else if (ch === "}" && depth > 0) depth--
    else if (ch === ":" && depth === 0) {
      return [str.slice(0, i), str.slice(i + 1)]
    }
  }
  return [str, ""]
}

function formatDuration(msStr: string): string {
  const ms = parseInt(msStr, 10)
  if (isNaN(ms)) return msStr
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds % 1 === 0 ? totalSeconds : totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}
