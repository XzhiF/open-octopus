// 空会话 composer 居中（2026-10-27 原型 v2）：
//   · 无消息 + heroEmpty ⇒ dock 居中（data-tui-hero），标题/第二行出现；
//   · 有消息 ⇒ 立刻回到底部停靠，第二行消失；
//   · 未开启 heroEmpty 的宿主（草稿工作台）行为不变。

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
  tui: true,
}

const msg = {
  id: "m1",
  session_id: "s1",
  role: "user" as const,
  content: "hi",
  created_at: new Date().toISOString(),
  is_summary: false,
  is_compressed: false,
  is_edited: false,
}

describe("ChatArea hero 空态", () => {
  it("无消息 + heroEmpty：composer 居中，标题与第二行可见", () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        heroEmpty
        composerHeroFooter={<span data-testid="hero-workspace">工作区槽</span>}
        identity={{ activeName: null, label: null, onSwitch: vi.fn() }}
      />,
    )

    expect(container.querySelector('[data-tui-hero="true"]')).toBeTruthy()
    expect(screen.getByText("开始新的对话")).toBeInTheDocument()
    expect(screen.getByTestId("hero-workspace")).toBeInTheDocument()
    // 身份 chip 由 ChatArea 自绘，点它打开单选身份面板
    expect(screen.getByTestId("tui-hero-identity")).toBeInTheDocument()
  })

  it("hero：只留模型可选，ctx / token 占位不出现", () => {
    render(
      <ChatArea
        {...baseProps}
        heroEmpty
        showUsagePlaceholders
        identity={{ activeName: null, label: null, onSwitch: vi.fn() }}
      />,
    )

    expect(screen.getByText("model")).toBeInTheDocument()
    expect(screen.queryByText(/ctx --%/)).toBeNull()
    expect(screen.queryByText("tok --")).toBeNull()
  })

  it("有消息：不再居中，第二行消失", () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        messages={[msg]}
        hasSession
        heroEmpty
        composerHeroFooter={<span data-testid="hero-workspace">工作区槽</span>}
      />,
    )

    expect(container.querySelector('[data-tui-hero="true"]')).toBeNull()
    expect(screen.queryByTestId("hero-workspace")).toBeNull()
  })

  it("未开启 heroEmpty（草稿工作台）：空会话仍停靠底部", () => {
    const { container } = render(<ChatArea {...baseProps} hasSession />)

    expect(container.querySelector('[data-tui-hero="true"]')).toBeNull()
    expect(screen.queryByText("开始新的对话")).toBeNull()
  })
})
