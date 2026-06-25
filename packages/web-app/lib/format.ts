export function formatDuration(seconds?: number): string {
  if (seconds == null || seconds <= 0) return "-"

  if (seconds < 60) {
    // < 1分钟: 45s
    return `${Math.round(seconds)}s`
  }

  if (seconds < 3600) {
    // < 1小时: 26min 21s
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    return `${minutes}min ${remainingSeconds}s`
  }

  // ≥ 1小时: 1h 17min 30s (包括 ≥ 24小时)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${hours}h ${minutes}min ${remainingSeconds}s`
}

export function formatTokenCount(n: number): string {
  if (n === 0) return "0"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
