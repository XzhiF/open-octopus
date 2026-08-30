/**
 * Web 展示层格式化器 — 全站唯一来源（C4 / ADR-0017）
 *
 * 只服务五个量纲家族：货币 / Token / 时长 / 百分比 / 字节。
 * 规范：
 * - null / undefined / NaN 一律渲染 "—"，不渲染假 0（C2/C3 三态语义的展示端）
 * - 货币消费 C3 的 LedgerCost 三态：formatCost(usd, complete)
 * - 时长入参唯一单位 = 毫秒（server wire 以 durationMs 为主）；秒制字段在调用方 * 1000
 * - Token 十进制 1000 与字节 1024 是两个合法家族，各只有一个函数，勿混用
 * - 有意不收编：score 域 toFixed（matchScore/consensus——语义数字非量纲）、
 *   明细弹层 toLocaleString 全量值（详情精确 / 徽章缩写是分层，不是分歧）
 */

/**
 * 货币三态格式化（消费 totals.cost = { usd, complete }）：
 * - usd == null     → "—"（未定价）
 * - complete=false  → "≈$"前缀（部分定价，已知部分和）
 * - ≥$1 两位小数，<$1 四位（自适应），千分位分隔；0 → "$0"
 */
export function formatCost(usd: number | null | undefined, complete = true): string {
  if (usd == null || Number.isNaN(usd)) return "—"
  if (usd === 0) return complete ? "$0" : "≈$0"
  const digits = usd >= 1 ? 2 : 4
  const num = usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${complete ? "$" : "≈$"}${num}`
}

/** Token 数紧凑格式化（十进制 1000）：<1K 整数原值，<1M → K，≥1M → M，均 1 位小数档 */
export function formatTokenCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * 时长格式化（**毫秒入参**）：850ms / 45s / 26m 21s / 1h 17m 四档。
 * null / NaN / <=0 → "—"（无耗时数据）。
 * 业务状态文案（如「进行中」）属调用方，不进本函数。
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms) || ms <= 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  if (minutes < 60) return `${minutes}m ${totalSec % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** 百分比格式化：入参量纲 0–1（与 cacheHitRate 同轨）；默认 0 位小数，调用点可显式传 digits */
export function formatPercent(rate: number | null | undefined, digits = 0): string {
  if (rate == null || Number.isNaN(rate)) return "—"
  return `${(rate * 100).toFixed(digits)}%`
}

/** 字节格式化（1024 家族唯一实现）：850 B / 1.5 KB / 2.3 MB…，SI 惯例带空格 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = Math.max(0, n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`
}
