import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ToolCallRecord } from "@/lib/agent/types"
import { ToolCallDialog } from "../ToolCallDialog"

const CALLS: ToolCallRecord[] = [
  { id: "t1", name: "Read", input: { file_path: "/repo/src/a.ts" }, status: "success" },
  { id: "t2", name: "Bash", input: { command: "pnpm test" }, status: "running" },
]

describe("ToolCallDialog", () => {
  it("弹窗里列出全部工具调用，标题带数量", () => {
    render(<ToolCallDialog open onOpenChange={vi.fn()} toolCalls={CALLS} />)

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("工具调用")).toBeInTheDocument()
    expect(screen.getByText("(2)")).toBeInTheDocument()
    expect(screen.getByText(/Read/)).toBeInTheDocument()
    expect(screen.getByText(/Bash/)).toBeInTheDocument()
  })

  it("关闭按钮回传 onOpenChange(false)", () => {
    const onOpenChange = vi.fn()
    render(<ToolCallDialog open onOpenChange={onOpenChange} toolCalls={CALLS} />)

    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("没有调用时不渲染弹窗内容", () => {
    render(<ToolCallDialog open={false} onOpenChange={vi.fn()} toolCalls={[]} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
