// packages/web-app/hooks/__tests__/useAgentChat-ask.test.ts
//
// useAgentChat 的 onAskUserQuestion 合并：ask_user_question SSE 必须落成
// name=AskUserQuestion + questions input 的 toolCall 记录，并随 onDone 进入
// 最终 assistant 消息（ChatArea 回合后恢复卡片的 in-memory 数据源；刷新后的
// 同源是 server 持久化 metadata）。id 命中既有记录（content_block 已先行）
// 时只补 input，不重复建条目、不重复 pin timeline。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage } from "@/lib/agent/types"
import type { AgentSSEConnection } from "@/lib/agent/api"

const SESSION_ID = "s-ask-1"

const QUESTIONS = {
  questions: [
    { question: "币种？", header: "H", multiSelect: false, options: [{ label: "A", description: "a" }] },
  ],
}

function sseChunks(...events: string[]): AgentSSEConnection {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e))
      c.close()
    },
  })
  return { reader: stream.getReader(), abort: vi.fn() } as unknown as AgentSSEConnection
}

const ev = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function makeHarness(conn: AgentSSEConnection) {
  const getSession = vi.fn(async () => ({
    session: { id: SESSION_ID } as never,
    messages: { items: [] as AgentMessage[], total: 0, has_more: false, next_cursor: null },
  }))
  const api: UseAgentChatApiOverride = {
    getSession,
    chatStream: vi.fn(() => conn),
    stopChat: vi.fn(async () => ({ success: true })),
  } as unknown as UseAgentChatApiOverride
  return { api }
}

beforeEach(() => { vi.restoreAllMocks() })

describe("useAgentChat — ask_user_question 合并", () => {
  it("content_block 已建记录 → ask 事件只补 input，单条不重复", async () => {
    const { api } = makeHarness(sseChunks(
      ev("tool_call", { type: "start", tool_call_id: "tu-a", tool_name: "AskUserQuestion" }),
      ev("ask_user_question", { tool_call_id: "tu-a", questions: QUESTIONS }),
      ev("done", { session_id: SESSION_ID, message_id: "a-1" }),
    ))
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    act(() => { void result.current.sendMessage("go") })
    await waitFor(() => expect(result.current.streaming).toBe(false))

    const assistant = result.current.messages.find((m) => m.role === "assistant")!
    const asks = (assistant.tool_calls ?? []).filter((tc) => tc.name === "AskUserQuestion")
    expect(asks).toHaveLength(1)
    expect(asks[0].id).toBe("tu-a")
    expect(asks[0].input).toEqual(QUESTIONS)
  })

  it("无 content_block（乱序/缺失）→ ask 事件自建记录并进最终消息", async () => {
    const { api } = makeHarness(sseChunks(
      ev("ask_user_question", { tool_call_id: "tu-b", questions: QUESTIONS }),
      ev("done", { session_id: SESSION_ID, message_id: "a-2" }),
    ))
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    act(() => { void result.current.sendMessage("go") })
    await waitFor(() => expect(result.current.streaming).toBe(false))

    const assistant = result.current.messages.find((m) => m.role === "assistant")!
    const ask = (assistant.tool_calls ?? []).find((tc) => tc.name === "AskUserQuestion")
    expect(ask, "onDone 前 toolCallsRef 应已含 AskUserQuestion").toBeDefined()
    expect(ask!.id).toBe("tu-b")
    expect((ask!.input as { questions?: unknown[] }).questions).toHaveLength(1)
  })
})
