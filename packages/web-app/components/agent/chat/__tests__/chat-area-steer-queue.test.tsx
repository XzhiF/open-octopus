// 2026-11-24 用户改判（classic 与全舱统一）：
//   ⏎ 执行中 = 排队（不打断）；⇧⏎ 执行中 = 直接打断接管（steer）；⇧⏎ 空闲 = 换行。
// 历史：2026-11-10 事故是「后台程序跑着时 ⏎ 会 steer，把 dev-up.sh 一起掐死」，
// 所以排队永远是默认动作，接管必须显式按 ⇧。

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

function typeAndEnter(container: HTMLElement, text: string, shiftKey = false) {
  const ta = container.querySelector("textarea")!
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: "Enter", shiftKey })
}

const queuedText = (container: HTMLElement) =>
  container.querySelector("[data-tui-queue]")?.textContent ?? ""

describe("ChatArea — ⏎ 排队 / ⇧⏎ 打断接管", () => {
  it("普通生成中：⏎ = 排队，不打断", () => {
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const { container } = render(
      <ChatArea {...baseProps} streaming onSteer={onSteer} onStop={onStop} />,
    )
    typeAndEnter(container, "换个方向")
    expect(onSteer).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(queuedText(container)).toContain("换个方向")
  })

  it("普通生成中：⇧⏎ = 打断接管", () => {
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const { container } = render(
      <ChatArea {...baseProps} streaming onSteer={onSteer} onStop={onStop} />,
    )
    typeAndEnter(container, "换个方向", true)
    expect(onSteer).toHaveBeenCalledWith("换个方向", undefined)
    expect(onStop).not.toHaveBeenCalled()
    expect(queuedText(container)).toBe("")
  })

  it("全舱变体同样语义：⇧⏎ 打断接管（不再插换行）", () => {
    const onSteer = vi.fn()
    const { container } = render(
      <ChatArea {...baseProps} streaming composerVariant="cockpit" onSteer={onSteer} />,
    )
    typeAndEnter(container, "换个方向", true)
    expect(onSteer).toHaveBeenCalledWith("换个方向", undefined)
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

  it("尾随他端回合（resumeTailing）：⏎ / ⇧⏎ 都排队，不调 steer", () => {
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const { container } = render(
      <ChatArea {...baseProps} streaming resumeTailing onSteer={onSteer} onStop={onStop} />,
    )
    typeAndEnter(container, "中断了？")
    typeAndEnter(container, "还是接着跑？", true)
    expect(onSteer).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(queuedText(container)).toContain("中断了？")
    expect(queuedText(container)).toContain("还是接着跑？")
  })

  it("空闲时 ⇧⏎ = 换行：不发送、不排队", () => {
    const onSend = vi.fn()
    const { container } = render(<ChatArea {...baseProps} onSend={onSend} />)
    const ta = container.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "第一行" } })
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(queuedText(container)).toBe("")
    expect(ta.value).toBe("第一行")
  })

  it("提示行如实说明当前键位语义", () => {
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
    const hint = steer.container.querySelector("[data-tui-hint]")?.textContent ?? ""
    expect(hint).toContain("⏎ 排队")
    expect(hint).toContain("⇧⏎ 打断接管")
  })
})
