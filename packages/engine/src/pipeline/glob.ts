/**
 * Match a string against a glob pattern.
 * Supports `*` (any characters) and `?` (single character).
 * Pattern special characters other than * and ? are treated as literals.
 *
 * Uses a segment-based algorithm (split on `*`, match via indexOf) to avoid
 * ReDoS from catastrophic backtracking in regex `.*` patterns.
 * Time complexity: O(n * m) worst case where n = str length, m = pattern length.
 */
export function globMatch(pattern: string, str: string): boolean {
  // Split pattern by '*' to get literal segments
  const segments = pattern.split("*")

  // No wildcards: exact match (with ? support)
  if (segments.length === 1) {
    return matchExact(pattern, str)
  }

  // First segment (before first *) must match at start
  const first = segments[0]
  if (first.length > 0) {
    if (str.length < first.length) return false
    if (!matchExact(first, str.slice(0, first.length))) return false
    str = str.slice(first.length)
  }

  // Last segment (after last *) must match at end
  const last = segments[segments.length - 1]
  if (last.length > 0) {
    if (str.length < last.length) return false
    const tail = str.slice(str.length - last.length)
    if (!matchExact(last, tail)) return false
    str = str.slice(0, str.length - last.length)
  }

  // Middle segments: find each in order (greedy left-to-right)
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (seg.length === 0) continue // consecutive '*' — skip
    const idx = indexOfExact(str, seg)
    if (idx < 0) return false
    str = str.slice(idx + seg.length)
  }

  return true
}

/** Match a pattern (may contain `?`) against a string of the same length. */
function matchExact(pattern: string, str: string): boolean {
  if (pattern.length !== str.length) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "?" && pattern[i] !== str[i]) return false
  }
  return true
}

/** Find the first occurrence of a pattern (may contain `?`) in str. Returns -1 if not found. */
function indexOfExact(str: string, pattern: string): number {
  if (pattern.length === 0) return 0
  const limit = str.length - pattern.length
  for (let i = 0; i <= limit; i++) {
    let match = true
    for (let j = 0; j < pattern.length; j++) {
      if (pattern[j] !== "?" && pattern[j] !== str[i + j]) {
        match = false
        break
      }
    }
    if (match) return i
  }
  return -1
}
