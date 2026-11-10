// 2026-11-10 用户事故：后台程序（run_in_background 的 dev-up.sh / 长命令）跑着
// 时，在输入框直接回车 = steer（先 stop 再重发）——服务端回合被掐断、后台进程
// 一起死掉，消息本身还可能被 resume 分支吞掉；用户只好再问一遍「起来了吗？」。
//
// 现在只有「本实例真的拥有这条流、且不在等后台任务」时 Enter 才是打断接管；
// 尾随他端回合（resumeTailing）和后台等待期间一律排队，回合收口后 done-flush
// 自动发出。

import { render, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { ChatArea } from "../ChatArea"
import type { ToolCallRecord } from "@/lib/agent/types"

const baseProps = {
  messages: [],
  streaming: false,
  streamContent: "",
  streamThinking: "",
  isThinking: false,
  toolCalls: [] as ToolCallRecord[],
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

function typeAndEnter(container: HTMLElement, text: string) {
  const ta = container.querySelector("textarea")!
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: "Enter" })
}

const queuedText = (container: HTMLElement) =>
  container.querySelector("[data-tui-queue]")?.textContent ?? ""

describe("ChatArea — 忙时 Enter 的接管 / 排队语义", () => {
  it("普通生成中（本实例拥有流、无后台任务）：⏎ = 打断接管", () => {
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const { container } = render(
      <ChatArea {...baseProps} streaming onSteer={onSteer} onStop={onStop} />,
    )
    typeAndEnter(container, "换个方向")
    expect(onSteer).toHaveBeenCalledWith("换个方向", undefined)
    expect(onStop).not.toHaveBeenCalled()
  })

  it("后台任务运行中：⏎ = 排队，不打断；回合收口后自动发出", () => {
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const onSend = vi.fn()
    const props = {
      ...baseProps,
      onSteer,
      onStop,
      onSend,
      backgroundTasks: [{ id: "bg-1", description: "bash scripts/dev-up.sh", taskType: "local_bash" }],
    }
    const { container, rerender } = render(<ChatArea {...props} streaming />)

    typeAndEnter(container, "起来了吗？")
    expect(onSteer).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(queuedText(container)).toContain("起来了吗？")

    // 回合收口（后台任务结束 + 唤醒续轮也跑完）→ 队首自动发出
    rerender(<ChatArea {...props} streaming={false} backgroundTasks={[]} />)
    expect(onSend).toHaveBeenCalledWith("起来了吗？", undefined)
  })

  it("尾随他端回合（resumeTailing）：⏎ = 排队，不调 steer", () => {
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const { container } = render(
      <ChatArea {...baseProps} streaming resumeTailing onSteer={onSteer} onStop={onStop} />,
    )
    typeAndEnter(container, "中断了？")
    expect(onSteer).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(queuedText(container)).toContain("中断了？")
  })

  it("提示行如实说明当前 Enter 的语义", () => {
    const bg = render(
      <ChatArea
        {...baseProps}
        streaming
        backgroundTasks={[{ id: "bg-1", description: "mvn install" }]}
      />,
    )
    expect(bg.container.querySelector("[data-tui-hint]")?.textContent).toContain("排队")

    const tail = render(<ChatArea {...baseProps} streaming resumeTailing />)
    expect(tail.container.querySelector("[data-tui-hint]")?.textContent).toContain("排队")

    const steer = render(<ChatArea {...baseProps} streaming onSteer={vi.fn()} />)
    expect(steer.container.querySelector("[data-tui-hint]")?.textContent).toContain("打断")
  })
})
