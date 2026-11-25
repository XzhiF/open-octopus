// 2026-11-23 用户 #8：后台等待期（turn_phase=background-wait）不锁输入 ——
//   · SSE 的 turn_phase 落到 hook 的 waitPhase（ChatArea 据此解锁输入框）；
//   · interject 走 /chat/inject，乐观消息进转录、不开新 SSE 回合；
//   · 回合真正收口（done）后 phase 清空。
// 全程 api override，不碰网络。

import { describe, it, expect, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage, AgentSession } from "@/lib/agent/types"
import type { AgentSSEConnection } from "@/lib/agent/api"

const SESSION_ID = "s-bg-inject-1"

function makeSse() {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c },
  })
  const reader = stream.getReader()
  const encoder = new TextEncoder()
  return {
    conn: { reader, abort: vi.fn() } as unknown as AgentSSEConnection,
    emit(event: string, data: unknown) {
      ctrl!.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    },
  }
}

function makeHarness() {
  const sse = makeSse()
  const getSession = vi.fn(async () => ({
    session: { id: SESSION_ID } as unknown as AgentSession,
    messages: { items: [] as AgentMessage[], total: 0, has_more: false, next_cursor: null },
  }))
  const chatStream = vi.fn(() => sse.conn)
  const stopChat = vi.fn(async () => ({ success: true }))
  const checkRunning = vi.fn(async () => ({ running: false, partial: false }))
  const injectChat = vi.fn(async () => ({ injected: true, session_id: SESSION_ID }))
  const api: UseAgentChatApiOverride = { getSession, chatStream, stopChat, checkRunning, injectChat }
  return { api, sse, getSession, chatStream, injectChat }
}

describe("useAgentChat — 后台等待期注入（#8）", () => {
  it("turn_phase 落到 waitPhase；interject 调 /chat/inject 并乐观入流；done 清空", async () => {
    const { api, sse, injectChat } = makeHarness()
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await new Promise((r) => setTimeout(r, 30)) // mount probe settles

    act(() => { void result.current.sendMessage("起个服务") })
    expect(result.current.streaming).toBe(true)

    act(() => {
      sse.emit("background_tasks", { tasks: [{ id: "bg-1", description: "dev server" }] })
      sse.emit("turn_phase", { phase: "background-wait" })
    })
    await waitFor(() => expect(result.current.waitPhase).toBe("background-wait"))

    let injected = false
    await act(async () => {
      injected = await result.current.interject("服务起来了吗？")
    })
    expect(injected).toBe(true)
    expect(injectChat).toHaveBeenCalledWith(SESSION_ID, "服务起来了吗？")
    expect(result.current.messages.some((m) => m.content === "服务起来了吗？")).toBe(true)
    // 注入不新开回合：仍是同一条 SSE，流保持打开。
    expect(result.current.streaming).toBe(true)

    act(() => {
      sse.emit("turn_phase", { phase: "generating" })
      sse.emit("done", { session_id: SESSION_ID, message_id: "a-1" })
    })
    await waitFor(() => expect(result.current.streaming).toBe(false))
    expect(result.current.waitPhase).toBeNull()
  })

  it("inject 失败 → 返回 false 并撤掉乐观行", async () => {
    const { api, injectChat } = makeHarness()
    injectChat.mockImplementation(async () => { throw Object.assign(new Error("busy"), { code: "STREAM_IN_PROGRESS" }) })
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await new Promise((r) => setTimeout(r, 30))
    act(() => { void result.current.sendMessage("起个服务") })

    let injected = true
    await act(async () => { injected = await result.current.interject("插一句") })
    expect(injected).toBe(false)
    expect(result.current.messages.some((m) => m.content === "插一句")).toBe(false)
  })
})
