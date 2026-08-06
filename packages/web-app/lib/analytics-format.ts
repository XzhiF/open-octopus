/**
 * 分析数据的共享格式化工具（R2-M-3）
 * 统一货币、时长、百分比的显示格式
 */

/** 货币格式化：$12.34（2 位小数） */
export const formatCurrency = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)

/** 时长格式化：< 1000ms 显示 ms，否则显示 s */
export const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

/** 百分比格式化：76.5% */
export const formatPercent = (value: number): string => `${value}%`

/** Token 数量紧凑格式化：< 1K 原值，< 1M 显示 K，≥ 1M 显示 M */
export const formatTokenCount = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
