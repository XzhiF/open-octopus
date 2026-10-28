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

  it("零调用不渲染 chip；placeholder 出占位", () => {
    render(<TaskCostChip usage={{ ...PAYLOAD, summary: { ...PAYLOAD.summary, totalCalls: 0 }, breakdown: [] }} />)
    expect(document.querySelector('[data-task-cost]')).toBeNull()
    render(<TaskCostChip usage={null} placeholder />)
    expect(screen.getByText("task tok --")).toBeInTheDocument()
  })
})
