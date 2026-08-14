/**
 * Parse human-readable token amounts like "50K", "1.5M" into numbers.
 * Accepts both numbers and strings. Strings support K/k (×1000) and M/m (×1,000,000) suffixes.
 *
 * @example
 * parseTokenAmount(50000)     // → 50000
 * parseTokenAmount("50K")     // → 50000
 * parseTokenAmount("1.5M")    // → 1500000
 * parseTokenAmount("100k")    // → 100000
 */
export function parseTokenAmount(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid token amount: ${value}`)
    }
    return Math.round(value)
  }

  const trimmed = String(value).trim()
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/)
  if (!match) {
    throw new Error(`Invalid token amount: "${value}". Use a number or string like "50K", "1.5M"`)
  }

  const num = parseFloat(match[1])
  const suffix = match[2].toUpperCase()

  if (suffix === "K") return Math.round(num * 1_000)
  if (suffix === "M") return Math.round(num * 1_000_000)
  return Math.round(num)
}
