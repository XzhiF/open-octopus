import { describe, it, expect } from "vitest"
import { formatCost, formatTokenCount, formatDuration, formatPercent, formatBytes } from "../format"

// C4 / ADR-0017：展示层格式化器单源。
// 表驱动逐例钉死共识边界：三态文案、自适应精度、四档时长、量纲契约。

describe("formatCost — 三态 + 自适应精度", () => {
  it.each([
    // [usd, complete, 期望]
    [null, true, "—"],           // 未定价 → 破折号（不渲染假 $0）
    [null, false, "—"],          // null 优先于 complete
    [undefined, true, "—"],
    [NaN, true, "—"],
    [0, true, "$0"],             // 定价为零 ≠ 未定价
    [0, false, "≈$0"],
    [0.05, true, "$0.0500"],     // <$1 → 4 位（终结 $0.05 vs $0.0500 同屏打架）
    [0.05, false, "≈$0.0500"],   // 部分定价 → ≈ 前缀
    [0.99999, true, "$1.0000"],  // <1 分支边界内保持 4 位
    [1, true, "$1.00"],          // ≥$1 → 2 位
    [12.345, true, "$12.35"],
    [1234.5, true, "$1,234.50"], // 千分位
    [1234.5, false, "≈$1,234.50"],
  ])("formatCost(%s, %s) === %s", (usd, complete, expected) => {
    expect(formatCost(usd as number | null, complete as boolean)).toBe(expected)
  })
})

describe("formatTokenCount — 十进制 1000", () => {
  it.each([
    [null, "—"],
    [0, "0"],                  // 0 是实数不是空值
    [999, "999"],
    [1000, "1.0K"],
    [1234, "1.2K"],
    [999_499, "999.5K"],
    [1_000_000, "1.0M"],       // summary-bar 旧副本缺 M 档 → 1500.0K，此例钉死不再复发
    [1_500_000, "1.5M"],
    [12_300_000, "12.3M"],
  ])("formatTokenCount(%s) === %s", (n, expected) => {
    expect(formatTokenCount(n as number | null)).toBe(expected)
  })
})

describe("formatDuration — 毫秒入参四档", () => {
  it.each([
    [null, "—"],
    [0, "—"],                  // <=0 视为无数据（继承旧秒版语义）
    [-5, "—"],
    [850, "850ms"],
    [999, "999ms"],
    [1000, "1s"],
    [45_400, "45s"],           // 秒档无小数：1.5s→2s 纠错性统一
    [1500, "2s"],
    [59_499, "59s"],
    [60_000, "1m 0s"],
    [1_581_000, "26m 21s"],    // 旧「26min 21s」→ 归一「26m 21s」
    [3_600_000, "1h 0m"],
    [4_650_000, "1h 17m"],
    [90_000_000, "25h 0m"],    // 无天档，h 直接累加（与旧秒版一致）
  ])("formatDuration(%s) === %s", (ms, expected) => {
    expect(formatDuration(ms as number | null)).toBe(expected)
  })
})

describe("formatPercent — 入参量纲 0–1", () => {
  it.each([
    [null, 0, "—"],
    [0, 0, "0%"],
    [1, 0, "100%"],
    [0.765, 0, "77%"],
    [0.765, 1, "76.5%"],       // digits 显式传 1（cacheHitRate 钻取场景）
    [0.9996, 0, "100%"],
  ])("formatPercent(%s, %s) === %s", (rate, digits, expected) => {
    expect(formatPercent(rate as number | null, digits as number)).toBe(expected)
  })
})

describe("formatBytes — 1024 家族", () => {
  it.each([
    [null, "—"],
    [0, "0 B"],
    [850, "850 B"],
    [1024, "1.0 KB"],          // SI 空格惯例
    [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [3.2 * 1024 ** 3, "3.2 GB"],
  ])("formatBytes(%s) === %s", (n, expected) => {
    expect(formatBytes(n as number | null)).toBe(expected)
  })
})
