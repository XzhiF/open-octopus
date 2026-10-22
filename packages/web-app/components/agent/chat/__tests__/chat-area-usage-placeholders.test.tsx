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
  it("空会话固定显示 ctx --% 与 tok --", () => {
    render(<ChatArea {...baseProps} showUsagePlaceholders />)

    expect(screen.getByText("ctx --%")).toBeDefined()
    expect(screen.getByText("tok --")).toBeDefined()
    expect(screen.getByRole("combobox")).toHaveProperty("value", "pro")
  })

  it("未开启占位时保持既有行为：不渲染 ctx/tok 槽", () => {
    render(<ChatArea {...baseProps} />)

    expect(screen.queryByText("ctx --%")).toBeNull()
    expect(screen.queryByText("tok --")).toBeNull()
  })
})
