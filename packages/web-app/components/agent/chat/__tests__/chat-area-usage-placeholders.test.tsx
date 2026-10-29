import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
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
}

describe("ChatArea usage placeholders", () => {
  it("空会话固定显示 ctx 占位（-- / -- · --%）与 tok --", () => {
    render(<ChatArea {...baseProps} showUsagePlaceholders />)

    expect(screen.getByText("-- / -- · --%")).toBeDefined()
    expect(screen.getByText("tok --")).toBeDefined()
    expect(screen.getByRole("combobox")).toHaveProperty("value", "pro")
  })

  it("TUI（对话首页 terminal 皮肤）空会话同样保留 ctx / tok 占位", () => {
    render(<ChatArea {...baseProps} tui showUsagePlaceholders />)

    expect(screen.getByText(/-- \/ -- · --%/)).toBeDefined()
    expect(screen.getByText("tok --")).toBeDefined()
  })

  it("未开启占位时保持既有行为：不渲染 ctx/tok 槽", () => {
    render(<ChatArea {...baseProps} />)

    expect(screen.queryByText("-- / -- · --%")).toBeNull()
    expect(screen.queryByText("tok --")).toBeNull()
  })
})

describe("ChatArea ctx 估算标记", () => {
  const estimated = {
    categories: [],
    totalTokens: 98912,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 49.5,
    model: "claude-opus-5",
    estimated: true,
  }

  it("估算值以 `已用 / 上限 · ~N%` 呈现，不冒充精确值", () => {
    const { container } = render(<ChatArea {...baseProps} hasSession contextUsage={estimated} />)
    expect(container.textContent).toContain("98.9K / 200K · ~49.5%")
  })

  it("provider 上报值不带 ~", () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        hasSession
        contextUsage={{ ...estimated, estimated: undefined, percentage: 5, totalTokens: 43960, maxTokens: 967000 }}
      />,
    )
    expect(container.textContent).toContain("44.0K / 967K · 5.0%")
    expect(container.textContent).not.toContain("· ~")
  })
})
