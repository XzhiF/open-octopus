import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TokenAggregateLine } from "../token-aggregate-line"
import type { TokenUsage } from "@/lib/types"

// 节点卡片主行统一口径：模型 · ∑处理量(含缓存) · N次 · 费用(ledger 三态)。

describe("TokenAggregateLine", () => {
  it("单 usage：模型 + ∑四路合计 + usage 自带费用（complete=false → ≈）", () => {
    const u: TokenUsage = {
      model: "qwen3.8-flash[1M]", inputTokens: 30, outputTokens: 507,
      cacheReadTokens: 22900, cacheCreationTokens: 6100, costUsd: 0.0473, costComplete: false,
    }
    render(<TokenAggregateLine usage={u} />)
    expect(screen.getByText("qwen3.8-flash[1M]")).toBeTruthy()
    expect(screen.getByText("∑29.5K")).toBeTruthy()
    expect(screen.getByText("≈$0.0473")).toBeTruthy()
  })

  it("多模型：标签折叠为首模型 +N，∑ 为全模型合计；不取明细费用", () => {
    const usages: TokenUsage[] = [
      { model: "m-a", inputTokens: 100, outputTokens: 100, costUsd: 0.01 },
      { model: "m-b", inputTokens: 50, outputTokens: 50, costUsd: 0.02 },
    ]
    render(<TokenAggregateLine usage={usages} />)
    expect(screen.getByText("m-a +1")).toBeTruthy()
    expect(screen.getByText("∑300")).toBeTruthy()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it("execution-node 形态：显式 costUsd + turnCount → N次 + $；零 token 也渲染", () => {
    render(<TokenAggregateLine usage={[]} requestCount={4} costUsd={0.05} />)
    expect(screen.getByText("4次")).toBeTruthy()
    expect(screen.getByText("$0.0500")).toBeTruthy()
  })

  it("无数据（∑=0 且无次数无费用）→ 渲染 null", () => {
    const { container } = render(
      <TokenAggregateLine usage={[{ model: "m", inputTokens: 0, outputTokens: 0 }]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("未定价三态：costUsd=null 显式传入 → 不渲染费用段（不焊假 $0），∑ 仍在", () => {
    render(<TokenAggregateLine usage={[{ model: "m", inputTokens: 10, outputTokens: 0 }]} costUsd={null} />)
    expect(screen.getByText("∑10")).toBeTruthy()
    expect(screen.queryByText(/\$/)).toBeNull()
    expect(screen.queryByText("—")).toBeNull()
  })
})
