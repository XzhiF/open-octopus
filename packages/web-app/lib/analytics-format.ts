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
