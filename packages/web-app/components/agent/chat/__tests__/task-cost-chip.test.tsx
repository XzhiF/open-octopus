// 2026-10-28 任务台账 = 账本全集（用户设计确认）：
//   ① 弹层含合计四项明细网格（输入/输出/缓存读/缓存写）；
//   ② 每个来源行自带四项 tooltip —— 「主对话」行即原 SessionCostChip 的口径，
//     TaskCostChip 是它的超集，任务态只挂一枚 chip 不重复。
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { TaskUsagePayload } from "@/lib/tasks-api"
import { TaskCostChip } from "../task-cost-chip"

vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "CNY", rate: 7 }),
}))

const PAYLOAD: TaskUsagePayload = {
  task_id: "t1",
  summary: {
    totalCalls: 40,
    usage: { inputTokens: 50000, outputTokens: 20000, cacheReadTokens: 1600000, cacheCreationTokens: 80000 },
    totals: { tokens: 1750000, cost: { usd: 1.2, complete: true }, cacheHitRate: 0.918 },
    modelBreakdown: {
      "claude-opus-5": {
        calls: 30, inputTokens: 40000, outputTokens: 18000,
        cacheReadTokens: 1400000, cacheCreationTokens: 70000, costUsd: 1.0,
      },
      "claude-haiku-5-5": {
        calls: 10, inputTokens: 10000, outputTokens: 2000,
        cacheReadTokens: 200000, cacheCreationTokens: 10000, costUsd: 0.2,
      },
    },
  },
  breakdown: [
    {
      kind: "chat",
      label: "主对话",
      session_id: "s1",
      totalCalls: 12,
      usage: { inputTokens: 900, outputTokens: 15000, cacheReadTokens: 1200000, cacheCreationTokens: 60000 },
      totals: { tokens: 1275900, cost: { usd: 0.8, complete: true }, cacheHitRate: 0.94 },
    },
  ],
}

const openPopover = () => {
  render(<TaskCostChip usage={PAYLOAD} />)
  fireEvent.click(document.querySelector('[data-task-cost]')!)
}

describe("TaskCostChip — 台账全集", () => {
  it("弹层渲染合计四项网格（输入/输出/缓存读/缓存写）", () => {
    openPopover()
    const grid = screen.getByTestId("usage-totals-grid")
    expect(grid).toBeInTheDocument()
    expect(within(grid).getByText("输入")).toBeInTheDocument()
    expect(within(grid).getByText("输出")).toBeInTheDocument()
    expect(within(grid).getByText("缓存读")).toBeInTheDocument()
    expect(within(grid).getByText("缓存写")).toBeInTheDocument()
  })

  it("来源行自带四项 tooltip（含请求数）", () => {
    openPopover()
    expect(screen.getByTitle(/12 次请求 · 输入 .* \/ 输出 .* \/ 缓存读 .* \/ 缓存写/)).toBeInTheDocument()
  })

  it("按模型分解（2026-10-29）：模型名 / 次数 / 处理量 / 费用，按处理量降序", () => {
    openPopover()
    const block = screen.getByTestId("model-breakdown")
    expect(block.textContent).toContain("claude-opus-5")
    expect(block.textContent).toContain("30 次")
    expect(block.textContent).toContain("claude-haiku-5-5")
    // opus 处理量更大 → 排在前面
    expect(block.textContent!.indexOf("claude-opus-5")).toBeLessThan(block.textContent!.indexOf("claude-haiku-5-5"))
    // 费用跟随计费设置（1.0 USD × 7）
    expect(block.textContent).toContain("¥7.00")
    // 触发钮 tooltip 也带模型名
    expect(document.querySelector('[data-task-cost]')!.getAttribute("title")).toContain("claude-opus-5")
  })

  it("零调用不渲染 chip；placeholder 出占位", () => {
    render(<TaskCostChip usage={{ ...PAYLOAD, summary: { ...PAYLOAD.summary, totalCalls: 0 }, breakdown: [] }} />)
    expect(document.querySelector('[data-task-cost]')).toBeNull()
    render(<TaskCostChip usage={null} placeholder />)
    expect(screen.getByText("task tok --")).toBeInTheDocument()
  })
})
