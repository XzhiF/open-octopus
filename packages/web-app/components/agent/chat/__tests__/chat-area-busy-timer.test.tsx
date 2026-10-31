// Composer 计时（2026-10-29 用户）：
//   ① 输入框下方不再重复 `⠋ thinking 2.1s` —— 状态/计时只留流尾工作行；
//   ② 切走再切回来，工作行的时间从本轮真实起点继续（turnStartedAt，不再归零）；
//   ③ 只显示整秒，不显示小数。

import { render } from "@testing-library/react"
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
  hasSession: true,
  currentModel: "pro",
  onModelChange: vi.fn(),
  tui: true,
}

function workline(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-tui-workline]") as HTMLElement | null
}

describe("ChatArea 计时", () => {
  it("turnStartedAt 已过去 12s → 工作行显示 12s（整秒，无小数）", () => {
    const { container } = render(
      <ChatArea {...baseProps} streaming isThinking turnStartedAt={Date.now() - 12_000} />,
    )
    const line = workline(container)!
    expect(line.textContent).toMatch(/\b12s\b/)
    expect(line.textContent).not.toMatch(/\d\.\d+s/)
  })

  it("输入框下方的旧 busy 行已移除（不再出现 data-tui-busy）", () => {
    const { container } = render(<ChatArea {...baseProps} streaming turnStartedAt={Date.now() - 5_000} />)
    expect(container.querySelector("[data-tui-busy]")).toBeNull()
  })

  it("无 turnStartedAt 时退回本地起点，从 0s 起算（不会出现巨大耗时）", () => {
    const { container } = render(<ChatArea {...baseProps} streaming />)
    const line = workline(container)!
    expect(line.textContent).toMatch(/\b[0-9]{1,2}s\b/)
  })
})
