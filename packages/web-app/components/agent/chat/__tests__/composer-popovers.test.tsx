import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ContextUsageData } from "@/lib/agent/types"
import { ChatArea } from "../ChatArea"

const baseProps = {
  messages: [],
  streaming: false,
  streamContent: "",
  streamThinking: "",
  isThinking: false,
  toolCalls: [],
  pendingConfirm: null,
  error: null,
  statusMessage: "",
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: false,
  currentModel: "pro",
  onModelChange: vi.fn(),
  tui: true,
}

const CTX = {
  categories: [
    { name: "系统提示", tokens: 12000, color: "#D2A8FF" },
    { name: "线程历史", tokens: 42000, color: "#4FD1D9" },
  ],
  totalTokens: 84000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 42,
  model: "pro",
} as ContextUsageData

describe("composer model / ctx 弹层", () => {
  it("model 弹层选别名后回调，弹层保持打开", () => {
    const onModelChange = vi.fn()
    render(<ChatArea {...baseProps} onModelChange={onModelChange} />)

    fireEvent.click(screen.getByRole("button", { name: "模型" }))
    fireEvent.click(screen.getByText("pro-max"))

    expect(onModelChange).toHaveBeenCalledWith("pro-max")
    expect(screen.getByText("思考强度")).toBeInTheDocument()
  })

  it("模型列表直接展示每个模型自己的预设", () => {
    render(
      <ChatArea
        {...baseProps}
        modelPresets={{
          "pro-max": { effort: "high", context: "1m" },
          pro: { effort: "high", context: "200k" },
          se: { effort: "low", context: "200k" },
        }}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "模型" }))

    expect(screen.getByText("高 · 1M")).toBeInTheDocument()
    expect(screen.getByText("高 · 200K")).toBeInTheDocument()
    expect(screen.getByText("低 · 200K")).toBeInTheDocument()
  })

  it("模型弹层可调思考强度与最大上下文", () => {
    const onEffortChange = vi.fn()
    const onMaxContextChange = vi.fn()
    render(
      <ChatArea
        {...baseProps}
        effort="high"
        maxContext="200k"
        onEffortChange={onEffortChange}
        onMaxContextChange={onMaxContextChange}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "模型" }))
    fireEvent.click(screen.getByRole("button", { name: /^最大$/ }))
    fireEvent.click(screen.getByRole("button", { name: /^1M/ }))

    expect(onEffortChange).toHaveBeenCalledWith("max")
    expect(onMaxContextChange).toHaveBeenCalledWith("1m")
  })

  it("ctx 弹层展示占用明细", () => {
    render(<ChatArea {...baseProps} contextUsage={CTX} />)

    fireEvent.click(screen.getByRole("button", { name: /84\.0K \/ 200K · 42\.0%/ }))

    expect(screen.getByText("上下文占用")).toBeInTheDocument()
    expect(screen.getByText("系统提示")).toBeInTheDocument()
    expect(screen.getByText("线程历史")).toBeInTheDocument()
  })
})
