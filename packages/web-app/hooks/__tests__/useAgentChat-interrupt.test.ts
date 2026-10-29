// packages/web-app/hooks/__tests__/useAgentChat-interrupt.test.ts
//
// 2026-10-29 用户 bug：「中断 agent 输出后，被中断的会话全都不见了」——
// 本地流按停止时，客户端只拿 refs 拼一条 partial（思考阶段停下时连 refs 都是
// 空的），server 已落库的 interrupted 行从不回读；冷加载时残留的
// metadata.streaming 行也不显示「本轮被截断」。
//
// 现在：
//   I1  停止本地流 → stopChat 后重拉实录，服务端 interrupted 行成为正史
//   I2  冷加载的孤儿 streaming 行（没有人在跑）→ 落成「已中断」
//
// 全程走 api override，不碰网络。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage, AgentSession } from "@/lib/agent/types"
import type { AgentSSEConnection } from "@/lib/agent/api"

const SESSION_ID = "s-interrupt-1"

function row(partial: Partial<AgentMessage> & { id: string; role: AgentMessage["role"] }): AgentMessage {
  return {
    session_id: SESSION_ID,
    content: "",
    created_at: new Date().toISOString(),
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...partial,
  } as AgentMessage
}

function makeHarness() {
  const getSession = vi.fn(async () => ({
    session: { id: SESSION_ID } as unknown as AgentSession,
    messages: { items: [] as AgentMessage[], total: 0, has_more: false, next_cursor: null },
  }))
  const chatStream = vi.fn(() => ({
    // Never-resolving reader: a live stream nobody completes in-test.
    reader: { read: () => new Promise(() => {}) } as unknown as ReadableStreamDefaultReader<Uint8Array>,
    abort: vi.fn(),
  } as unknown as AgentSSEConnection))
  const stopChat = vi.fn(async () => ({ success: true }))
  const checkRunning = vi.fn(async () => ({ running: false, partial: false }))
  const api: UseAgentChatApiOverride = { getSession, chatStream, stopChat, checkRunning }
  return { api, getSession, chatStream, stopChat, checkRunning }
}

beforeEach(() => { vi.restoreAllMocks() })

describe("useAgentChat interrupt", () => {
  it("I1: 停止本地流 → 重拉实录，服务端 interrupted 行成为正史", async () => {
    const { api, getSession, stopChat } = makeHarness()
    const interrupted = row({ id: "a-int", role: "assistant", content: "写到一半", interrupted: true })
    getSession.mockImplementation(async () => ({
      session: { id: SESSION_ID } as unknown as AgentSession,
      messages: {
        items: [row({ id: "u-1", role: "user", content: "hi" }), interrupted],
        total: 2, has_more: false, next_cursor: null,
      },
    }))

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await new Promise((r) => setTimeout(r, 30)) // mount probe settles (running=false)

    act(() => { void result.current.sendMessage("hi") })
    expect(result.current.streaming).toBe(true)

    await act(async () => { await result.current.stopGenerate() })

    expect(stopChat).toHaveBeenCalledWith(SESSION_ID)
    expect(getSession).toHaveBeenCalled()
    await waitFor(() => {
      const hit = result.current.messages.find((m) => m.id === "a-int")
      expect(hit?.interrupted).toBe(true)
    })
    expect(result.current.messages.map((m) => m.id)).toEqual(["u-1", "a-int"])
    expect(result.current.streaming).toBe(false)
  })

  it("I2: 冷加载的孤儿 streaming 行 → 无人在跑时落成「已中断」", async () => {
    const { api, getSession } = makeHarness()
    getSession.mockImplementation(async () => ({
      session: { id: SESSION_ID } as unknown as AgentSession,
      messages: {
        items: [row({ id: "a-orphan", role: "assistant", content: "半截", streaming: true })],
        total: 1, has_more: false, next_cursor: null,
      },
    }))

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await new Promise((r) => setTimeout(r, 30))

    await act(async () => { await result.current.loadMessages() })

    const hit = result.current.messages.find((m) => m.id === "a-orphan")
    expect(hit?.interrupted).toBe(true)
    expect(hit?.streaming).toBe(false)
  })
})
