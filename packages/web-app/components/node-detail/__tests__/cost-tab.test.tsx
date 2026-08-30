import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { CostTab } from "../cost-tab"
import type { LLMCallAggregates } from "@/lib/types"

// agent 详情「成本」页：llm_calls 单一真相源 —— 总计 ∑+四路、请求/工具次数、每模型全量。

const agg: LLMCallAggregates = {
  totalCalls: 4,
  toolCalls: 5,
  usage: { inputTokens: 30, outputTokens: 507, cacheReadTokens: 22900, cacheCreationTokens: 6100 },
  totals: { tokens: 29537, cost: { usd: 0.0473, complete: true }, cacheHitRate: null },
  modelBreakdown: {
    "qwen3.8-flash[1M]": { calls: 3, inputTokens: 20, outputTokens: 400, cacheReadTokens: 20000, cacheCreationTokens: 5000, costUsd: 0.04 },
    "haiku-4.5": { calls: 1, inputTokens: 10, outputTokens: 107, cacheReadTokens: 2900, cacheCreationTokens: 1100, costUsd: null },
  },
}

describe("CostTab", () => {
  it("总计：∑处理量 + 四路 + 请求/工具次数 + 费用", () => {
    render(<CostTab aggregates={agg} />)
    expect(screen.getByText("∑29.5K")).toBeTruthy()
    expect(screen.getByText("↑30")).toBeTruthy()
    expect(screen.getByText("↓507")).toBeTruthy()
    expect(screen.getByText("⚡22.9K")).toBeTruthy()
    expect(screen.getByText("🗡️6.1K")).toBeTruthy()
    expect(screen.getByText("4 次请求")).toBeTruthy()
    expect(screen.getByText("5 次工具调用")).toBeTruthy()
    expect(screen.getByText("$0.0473")).toBeTruthy()
  })

  it("每模型：四路 + ∑ + calls + 费用三态（null → —，不焊假 $0）", () => {
    render(<CostTab aggregates={agg} />)
    expect(screen.getByText("qwen3.8-flash[1M]")).toBeTruthy()
    expect(screen.getByText("haiku-4.5")).toBeTruthy()
    expect(screen.getByText("3 calls · $0.0400")).toBeTruthy()
    expect(screen.getByText("1 calls · —")).toBeTruthy()
  })

  it("totalCalls=0 → 空态", () => {
    render(<CostTab aggregates={{ ...agg, totalCalls: 0 }} />)
    expect(screen.getByText("暂无 LLM 调用数据")).toBeTruthy()
  })
})
