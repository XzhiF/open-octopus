/**
 * Web 展示层格式化器 — 全站唯一来源（C4 / ADR-0017）
 *
 * 只服务六个量纲家族：货币 / Token / 时长 / 百分比 / 字节 / 相对时间。
 * 规范：
 * - null / undefined / NaN 一律渲染 "—"，不渲染假 0（C2/C3 三态语义的展示端）
 * - 货币消费 C3 的 LedgerCost 三态：formatCost(usd, complete)
 * - 时长入参唯一单位 = 毫秒（server wire 以 durationMs 为主）；秒制字段在调用方 * 1000
 * - Token 十进制 1000 与字节 1024 是两个合法家族，各只有一个函数，勿混用
 * - 有意不收编：score 域 toFixed（matchScore/consensus——语义数字非量纲）、
 *   明细弹层 toLocaleString 全量值（详情精确 / 徽章缩写是分层，不是分歧）
 */

/** 展示币种（v49）：跟随计费设置 billing_setting 的 display_currency + usd_to_cny。 */
export interface CostDisplay {
  currency: "USD" | "CNY"
  /** 1 USD = rate CNY；USD 展示时无视。 */
  rate: number
}

/**
 * 货币三态格式化（消费 totals.cost = { usd, complete }）：
 * - usd == null     → "—"（未定价）
 * - complete=false  → "≈$"前缀（部分定价，已知部分和）
 * - ≥$1 两位小数，<$1 四位（自适应），千分位分隔；0 → "$0"
 * - display 传了 CNY → 先按 rate 折算再走同一自适应/千分位/三态规则（符号换 ¥）；
 *   不传 = 恒 USD，与既有全部调用点逐字一致。
 */
export function formatCost(
  usd: number | null | undefined,
  complete = true,
  display?: CostDisplay,
): string {
  if (usd == null || Number.isNaN(usd)) return "—"
  const cny = display?.currency === "CNY"
  const symbol = cny ? "¥" : "$"
  const amount = cny ? usd * display.rate : usd
  if (amount === 0) return complete ? `${symbol}0` : `≈${symbol}0`
  // USD 小额用 4 位（$0.0032 有信息量）；CNY 最小实用单位是「分」，2 位足够。
  const digits = cny || Math.abs(amount) >= 1 ? 2 : 4
  const num = amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${complete ? symbol : `≈${symbol}`}${num}`
}

/**
 * Token 数紧凑格式化（十进制 1000）：<1K 整数原值，<1M → K，≥1M → M。
 * digits = K/M 档的小数位（默认 1；计费域传 2 —— 单价小、token 缩得太狠会丢分辨力）。
 */
export function formatTokenCount(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(digits)}K`
  return `${(n / 1_000_000).toFixed(digits)}M`
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

/**
 * 秒表格式化（**毫秒入参**，一直往上走的计数器用）：0s / 45s / 26m 21s / 8h 29m 12s。
 * 与 formatDuration 分档同词，差别只有一处：小时档也保留秒。
 * 挂在一秒一跳的读数上（如运行窗口总耗时），formatDuration 的「8h 29m」到分钟
 * 为止 —— 秒表会看着不动，正是要的效果反过来。0 是合法读数（刚起跑），
 * 与 formatDuration 的「无数据」不同；入参负数/NaN/null → "—"。
 * 用 floor 不用 round：走表只增不减，四舍五入会倒跳。
 */
export function formatStopwatch(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "—"
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  if (minutes < 60) return `${minutes}m ${totalSec % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${totalSec % 60}s`
}

/**
 * 运行卡时钟读数：`06:32`（超过 1 小时才带小时位 `1:06:32`）。
 * 与 formatStopwatch 的区别 = 冒号读数、每秒跳动时不抖宽度（tabular-nums 配合）。
 */
export function formatRunClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
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

/**
 * 相对时间（看板卡片/工作空间卡同源）：刚刚 / N 分钟前 / N 小时前 / N 天前，
 * ≥7 天回退 zh-CN 日期；null / 非法 → "未知"。
 */
export function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return "未知"
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return "未知"
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return "刚刚"
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 7) return `${diffDays} 天前`
  return date.toLocaleDateString("zh-CN")
}
