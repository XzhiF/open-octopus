/**
 * Format USD cost with CNY conversion display
 * @param usd - Cost in USD
 * @returns Formatted string like "¥23.20 (≈$3.20)"
 */
export function formatCost(usd: number): string {
  const rate = parseFloat(process.env.NEXT_PUBLIC_EXCHANGE_RATE ?? '7.25')
  const cny = usd * rate
  return `¥${cny.toFixed(2)} (≈$${usd.toFixed(2)})`
}

export function formatCostUSD(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "—"
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m${remainSeconds > 0 ? ` ${remainSeconds}s` : ""}`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return `${hours}h${remainMinutes > 0 ? ` ${remainMinutes}m` : ""}`
}
