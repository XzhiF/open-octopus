import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TokenUsageDisplay } from "../token-usage-display"
import type { TokenUsage } from "@/lib/types"

// 节点 token 与监控面板「总 Token」同口径：cache 用 ⚡/🗡 显式分项，
// 使 ↑in+↓out+⚡cacheRead+🗡️cacheWrite == 面板合计（消除 537 vs 29.6K 的 55× 错觉）。

describe("TokenUsageDisplay — cache 分项徽标", () => {
  it("cacheRead/cacheCreation > 0 → 渲染 ⚡/🗡 与数值", () => {
    const usages: TokenUsage[] = [{
      model: "qwen3.8-flash[1M]", inputTokens: 30, outputTokens: 507,
      cacheReadTokens: 22900, cacheCreationTokens: 6100,
    }]
    render(<TokenUsageDisplay usages={usages} isRunning={false} />)
    expect(screen.getByText("↑30")).toBeTruthy()
    expect(screen.getByText("↓507")).toBeTruthy()
    expect(screen.getByText("⚡22.9K")).toBeTruthy()
    expect(screen.getByText("🗡️6.1K")).toBeTruthy()
  })

  it("无 cache → 不渲染 ⚡/🗡（只有 ↑↓）", () => {
    const usages: TokenUsage[] = [{ model: "m", inputTokens: 10, outputTokens: 20 }]
    render(<TokenUsageDisplay usages={usages} isRunning={false} />)
    expect(screen.getByText("↑10")).toBeTruthy()
    expect(screen.getByText("↓20")).toBeTruthy()
    expect(screen.queryByText(/⚡/)).toBeNull()
    expect(screen.queryByText(/🗡/)).toBeNull()
  })

  it("in/out 全 0 → 不渲染该行", () => {
    const usages: TokenUsage[] = [{ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 500 }]
    render(<TokenUsageDisplay usages={usages} isRunning={false} />)
    expect(screen.queryByText(/⚡/)).toBeNull()
  })
})
