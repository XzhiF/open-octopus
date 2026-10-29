import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { ContextUsageData } from "@/lib/agent/types"
import { ContextUsageChip, ContextUsagePlaceholder, ctxUsageTone } from "../context-usage-chip"

function ctx(over: Partial<ContextUsageData> = {}): ContextUsageData {
  return {
    categories: [],
    totalTokens: 80100,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 8.01,
    model: "claude-opus-5",
    ...over,
  }
}

describe("ContextUsageChip", () => {
  it("按 `已用 / 上限 · N.N%` 展示", () => {
    render(<ContextUsageChip contextUsage={ctx()} />)
    expect(screen.getByText(/80\.1K \/ 1M/)).toBeInTheDocument()
    expect(screen.getByText(/·/)).toBeInTheDocument()
    expect(screen.getByText("8.0%")).toBeInTheDocument()
  })

  it("进度填充宽度跟随百分比", () => {
    const { container } = render(<ContextUsageChip contextUsage={ctx({ percentage: 42 })} />)
    const fill = container.querySelector("[data-ctx-fill]") as HTMLElement
    expect(fill.style.width).toBe("42%")
  })

  it("估算值带 ~ 前缀", () => {
    render(<ContextUsageChip contextUsage={ctx({ percentage: 49.5, estimated: true })} />)
    expect(screen.getByText("~49.5%")).toBeInTheDocument()
  })

  it("百分比超界被夹到 0–100", () => {
    const { container } = render(<ContextUsageChip contextUsage={ctx({ percentage: 140 })} />)
    expect((container.querySelector("[data-ctx-fill]") as HTMLElement).style.width).toBe("100%")
    expect(screen.getByText("100.0%")).toBeInTheDocument()
  })

  it("分档配色：常规青 / 偏高琥珀 / 吃紧红", () => {
    expect(ctxUsageTone(20).text).toBe("text-pop-cyan")
    expect(ctxUsageTone(60).text).toBe("text-pop-amber")
    expect(ctxUsageTone(85).text).toBe("text-pop-red")
  })
})

describe("ContextUsagePlaceholder", () => {
  it("空会话显示同形占位", () => {
    render(<ContextUsagePlaceholder />)
    expect(screen.getByText("-- / -- · --%")).toBeInTheDocument()
  })
})
