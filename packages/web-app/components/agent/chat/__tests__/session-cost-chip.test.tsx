// v49 聊天 token 角标：composer 里 ctx 之后那枚 chip + 点开的账本明细。
// 钉两条最容易坏的地方：
//   ① 无账本（新会话/取数失败）→ 整枚不渲染，不出现「tok 0 / ¥0」假数据；
//   ② cache% 走账本 totals.cacheHitRate，ctx% 走 SDK context_usage —— 两个数不同源。
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { ReactNode } from "react"
import type { LlmUsageAggregates } from "@octopus/shared"
import type { ContextUsageData } from "@/lib/agent/types"
import { SessionCostChip } from "../session-cost-chip"

vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "CNY", rate: 7 }),
}))
vi.mock("next/link", () => ({
  // 透传 href/target/rel 成真 <a>，才能钉「完整台账」新标签页行为（1e842875）
  default: (props: { children: ReactNode; href?: string; target?: string; rel?: string }) => (
    <a href={props.href} target={props.target} rel={props.rel}>{props.children}</a>
  ),
}))

const CTX = { percentage: 43, totalTokens: 86100, maxTokens: 200000 } as ContextUsageData

const USAGE: LlmUsageAggregates = {
  totalCalls: 30,
  usage: { inputTokens: 45200, outputTokens: 18700, cacheReadTokens: 98400, cacheCreationTokens: 12300 },
  totals: {
    tokens: 174600,
    cost: { usd: 0.4583, complete: true },
    cacheHitRate: 98400 / (45200 + 98400 + 12300), // 分母含缓存写（ADR-0027）→ 63.1%
  },
  modelBreakdown: {
    "claude-sonnet-4.5": {
      calls: 24, inputTokens: 41000, outputTokens: 16200, cacheReadTokens: 98400, cacheCreationTokens: 12300,
      costUsd: 0.4416,
    },
  },
}

describe("SessionCostChip", () => {
  it("无账本 / 零调用 → 不渲染", () => {
    const { rerender } = render(<SessionCostChip usage={null} />)
    expect(screen.queryByText(/tok/)).toBeNull()
    rerender(<SessionCostChip usage={{ ...USAGE, totalCalls: 0 }} />)
    expect(screen.queryByText(/tok/)).toBeNull()
  })

  it("角标 = tok 总量 + 账本命中率 + 折算后的费用", () => {
    render(<SessionCostChip usage={USAGE} contextUsage={CTX} />)
    const chip = screen.getByRole("button")
    expect(chip.textContent).toContain("tok 174.6K")
    expect(chip.textContent).toContain("cache 63.1%")
    expect(chip.textContent).toContain("¥3.21")
  })

  it("点开明细：四分项 + 总和/命中率/ctx/费用 + 按模型 + 台账入口", () => {
    render(<SessionCostChip usage={USAGE} contextUsage={CTX} />)
    fireEvent.click(screen.getByRole("button"))

    expect(screen.getByText("输入")).toBeInTheDocument()
    expect(screen.getByText("缓存写")).toBeInTheDocument()
    expect(screen.getByText("45.2K")).toBeInTheDocument()
    expect(screen.getByText("12.3K")).toBeInTheDocument()
    expect(screen.getByText("总和")).toBeInTheDocument()
    // ctx 行走 SDK 占用（43%），与账本命中率（63.1%）并存且不同值
    expect(screen.getByText(/43% · 86\.1K \/ 200\.0K/)).toBeInTheDocument()
    expect(screen.getByText("claude-sonnet-4.5")).toBeInTheDocument()
    // 完整台账走新标签页（本分支 1e842875 行为补钉）——弹窗不被整页导航顶掉
    const ledgerLink = screen.getByText(/完整台账/)
    expect(ledgerLink).toHaveAttribute("target", "_blank")
    expect(ledgerLink).toHaveAttribute("rel", "noopener")
  })
})
