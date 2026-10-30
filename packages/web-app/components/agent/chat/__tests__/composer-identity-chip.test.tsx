// 输入框控件条的「当前身份」贴纸（2026-10-30 用户定稿）：
//   · 任务线程 = 只读紫幽兰框（无 ✕，身份由任务状态派生）；
//   · 普通会话 = 分身身份悬停露 ✕，点掉回主身份；
//   · hero 新会话的身份由下方选择器承担，贴纸不渲染。

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ComposerIdentityChip } from "../composer-identity-chip"
import { ComposerIdentityPicker } from "../composer-identity-picker"
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

describe("ComposerIdentityChip", () => {
  it("任务线程：只读紫框 + 锁形图标，不渲染清除钮", () => {
    render(<ComposerIdentityChip display={{ label: "执行者 · task-doer", active: true, readOnly: true }} />)
    const chip = screen.getByTestId("composer-identity-chip")
    expect(chip).toHaveAttribute("data-identity-mode", "readonly")
    expect(chip.textContent).toContain("执行者 · task-doer")
    expect(chip.className).toContain("bg-pop-purple-soft")
    expect(chip.querySelector("[data-identity-lock]")).toBeTruthy()
    expect(screen.queryByTestId("composer-identity-clear")).toBeNull()
  })

  it("普通会话：分身身份悬停露 ✕，点掉即回主身份", () => {
    const onClear = vi.fn()
    render(<ComposerIdentityChip display={{ label: "全栈开发助手", active: true, onClear }} />)
    const clear = screen.getByTestId("composer-identity-clear")
    expect(clear.className).toContain("group-hover:opacity-100")
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("基础身份：虚线紫框弱化，无清除钮", () => {
    render(<ComposerIdentityChip display={{ label: "主 Agent", active: false }} />)
    const chip = screen.getByTestId("composer-identity-chip")
    expect(chip).toHaveAttribute("data-identity-mode", "base")
    expect(chip.className).toContain("border-dashed")
    expect(screen.queryByTestId("composer-identity-clear")).toBeNull()
  })
})

describe("ChatArea 身份贴纸接线", () => {
  it("会话控件条渲染贴纸，✕ 触发清除", () => {
    const onClear = vi.fn()
    render(
      <ChatArea
        {...baseProps}
        identityDisplay={{ label: "全栈开发助手", active: true, onClear }}
      />,
    )
    const ctrlbar = document.querySelector("[data-tui-ctrlbar]")!
    expect(ctrlbar.contains(screen.getByTestId("composer-identity-chip"))).toBe(true)
    fireEvent.click(screen.getByTestId("composer-identity-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("hero 新会话不挂贴纸（身份走下方选择器）", () => {
    render(<ChatArea {...baseProps} hasSession={false} heroEmpty />)
    expect(screen.queryByTestId("composer-identity-chip")).toBeNull()
  })
})

describe("ComposerIdentityPicker（hero 新会话）", () => {
  it("已选分身时悬停露 ✕，点掉回主身份", () => {
    const onSelect = vi.fn()
    render(<ComposerIdentityPicker activeName="workspace" label="全栈开发助手" onSelect={onSelect} />)
    const clear = screen.getByTestId("tui-hero-identity-clear")
    fireEvent.click(clear)
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it("基础身份不渲染清除钮", () => {
    render(<ComposerIdentityPicker activeName={null} label={null} onSelect={vi.fn()} />)
    expect(screen.queryByTestId("tui-hero-identity-clear")).toBeNull()
  })
})
