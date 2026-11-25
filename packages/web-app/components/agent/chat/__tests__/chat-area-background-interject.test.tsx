// 2026-11-23 用户 #8：后台任务（dev 服务等）在跑、模型空闲等唤醒时，会话不算
// 「忙」—— 输入不锁，⏎ 直接注进同一条 provider 查询（不打断后台）。
//   1. canInterject：⏎ 走 onInterject，不排队 / 不 steer / 不 stop；
//   2. 进入后台等待时，队里积压的消息自动注入队首；
//   3. 非 TUI 变体输入框同样解锁，⏎ 走 onInterject。

import { render, fireEvent, waitFor } from "@testing-library/react"
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
}

const bgTasks = [{ id: "bg-1", description: "bash scripts/dev-up.sh", taskType: "local_bash" }]

function typeAndKey(container: HTMLElement, text: string, key: "Enter" | "Escape", shiftKey = false) {
  const ta = container.querySelector("textarea")!
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key, shiftKey })
}

const queuedText = (container: HTMLElement) =>
  container.querySelector("[data-tui-queue]")?.textContent ?? ""

describe("ChatArea — 后台等待期可以直接说话（#8）", () => {
  it("canInterject：⏎ 注入同一条查询，不排队、不 steer、不 stop", () => {
    const onInterject = vi.fn()
    const onSteer = vi.fn()
    const onStop = vi.fn()
    const { container } = render(
      <ChatArea
        {...baseProps}
        tui
        streaming
        canInterject
        onInterject={onInterject}
        onSteer={onSteer}
        onStop={onStop}
        backgroundTasks={bgTasks}
      />,
    )
    typeAndKey(container, "服务起来了吗？", "Enter")
    expect(onInterject).toHaveBeenCalledWith("服务起来了吗？")
    expect(onSteer).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(queuedText(container)).toBe("")
  })

  it("进入后台等待：队里积压的消息自动注入队首", () => {
    const onInterject = vi.fn()
    const props = {
      ...baseProps,
      tui: true,
      streaming: true,
      backgroundTasks: bgTasks,
      onInterject,
    }
    // 生成中先排一条（canInterject=false → 只排队）
    const { container, rerender } = render(<ChatArea {...props} />)
    typeAndKey(container, "起来了吗？", "Enter", true)
    expect(queuedText(container)).toContain("起来了吗？")
    expect(onInterject).not.toHaveBeenCalled()

    // 模型空闲、进入后台等待 → 队首注入，不打断后台
    rerender(<ChatArea {...props} canInterject />)
    expect(onInterject).toHaveBeenCalledWith("起来了吗？")
    expect(queuedText(container)).toBe("")
  })

  it("非 TUI：后台等待期输入框不锁，⏎ 走 onInterject", () => {
    const onInterject = vi.fn()
    const onSend = vi.fn()
    const { container } = render(
      <ChatArea
        {...baseProps}
        streaming
        canInterject
        onInterject={onInterject}
        onSend={onSend}
        backgroundTasks={bgTasks}
      />,
    )
    const ta = container.querySelector("textarea") as HTMLTextAreaElement
    expect(ta.disabled).toBe(false)
    typeAndKey(container, "服务起来了吗？", "Enter")
    expect(onInterject).toHaveBeenCalledWith("服务起来了吗？")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("没有注入通道时输入框保持锁定（生成中）", () => {
    const { container } = render(
      <ChatArea {...baseProps} streaming backgroundTasks={bgTasks} />,
    )
    const ta = container.querySelector("textarea") as HTMLTextAreaElement
    expect(ta.disabled).toBe(true)
  })

  // 2026-11-24 用户 #2：注入失败（本地相位过期 / 服务端正好收轮）原来被静默
  // 吞掉 —— 乐观行撤掉、输入框清空，用户的话凭空消失。失败必须转排队，可见。
  it("注入失败（同步 false）→ 消息转排队并在输入框上方可见", () => {
    const onInterject = vi.fn(() => false)
    const { container } = render(
      <ChatArea
        {...baseProps}
        tui
        streaming
        canInterject
        onInterject={onInterject}
        backgroundTasks={bgTasks}
      />,
    )
    typeAndKey(container, "服务起来了吗？", "Enter")
    expect(onInterject).toHaveBeenCalledWith("服务起来了吗？")
    expect(queuedText(container)).toContain("服务起来了吗？")
  })

  it("注入失败（异步 false）→ 消息回到队列，不丢", async () => {
    const onInterject = vi.fn(async () => false)
    const { container } = render(
      <ChatArea
        {...baseProps}
        tui
        streaming
        canInterject
        onInterject={onInterject}
        backgroundTasks={bgTasks}
      />,
    )
    typeAndKey(container, "还在吗？", "Enter")
    await waitFor(() => expect(queuedText(container)).toContain("还在吗？"))
  })

  it("后台等待时队首注入失败 → 队首放回队列", async () => {
    const onInterject = vi.fn(async () => false)
    const props = {
      ...baseProps,
      tui: true,
      streaming: true,
      backgroundTasks: bgTasks,
      onInterject,
    }
    const { container, rerender } = render(<ChatArea {...props} />)
    typeAndKey(container, "起来了吗？", "Enter", true)
    expect(queuedText(container)).toContain("起来了吗？")

    rerender(<ChatArea {...props} canInterject />)
    expect(onInterject).toHaveBeenCalledWith("起来了吗？")
    await waitFor(() => expect(queuedText(container)).toContain("起来了吗？"))
  })

  it("非 TUI 注入失败（没有排队区）→ 原文放回输入框", async () => {
    const onInterject = vi.fn(async () => false)
    const { container } = render(
      <ChatArea
        {...baseProps}
        streaming
        canInterject
        onInterject={onInterject}
        backgroundTasks={bgTasks}
      />,
    )
    typeAndKey(container, "服务起来了吗？", "Enter")
    await waitFor(() => {
      const ta = container.querySelector("textarea") as HTMLTextAreaElement
      expect(ta.value).toBe("服务起来了吗？")
    })
  })
})
