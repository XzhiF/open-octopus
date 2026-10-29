// packages/web-app/hooks/__tests__/useAgentChat-resume.test.ts
//
// "关闭不丢失" stream-resume — useAgentChat resume behavior. The resume path
// is driven entirely through the api override seam (checkRunning), so these
// tests inject a fake clone-chat API and never touch the network.
//
// Covered:
//   R1  mount probe: running=true → resume mode (streaming guard on, send blocked)
//   R2  poll exit: running flips false → streaming off, finalized row shown
//   R3  stop in resume mode: stopChat called, NO local partial bubble, stays
//       streaming until the poll observes the server-side finalization
//   R4  regression: no checkRunning override → mount does exactly what it
//       used to (no resume, input enabled)
//   R5  409 during send (STREAM_IN_PROGRESS transport error) → silently
//       converts into resume mode instead of an error banner

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage } from "@/lib/agent/types"
import type { AgentSSEConnection } from "@/lib/agent/api"

const SESSION_ID = "s-resume-1"

function partialRow(streaming = true): AgentMessage {
  return {
    id: "a-partial", session_id: SESSION_ID, role: "assistant",
    content: "server-side half", created_at: new Date().toISOString(),
    is_summary: false, is_compressed: false, is_edited: false, streaming,
  } as AgentMessage & { streaming: boolean }
}

function makeHarness(opts?: { running?: boolean }) {
  const state = { running: opts?.running ?? true }
  const getSession = vi.fn(async () => ({
    session: { id: SESSION_ID } as never,
    // The partial is finalized (streaming flag dropped) as soon as the server
    // turn ends — mirrors the real route's in-place finalize.
    messages: { items: [partialRow(state.running)], total: 1, has_more: false, next_cursor: null },
  }))
  const chatStream = vi.fn(() => ({
    // Never-resolving reader: simulates a live stream nobody completes in-test.
    reader: { read: () => new Promise(() => {}) } as unknown as ReadableStreamDefaultReader<Uint8Array>,
    abort: vi.fn(),
  } as unknown as AgentSSEConnection))
  const stopChat = vi.fn(async () => ({ success: true }))
  const checkRunning = vi.fn(async () => ({ running: state.running, partial: state.running }))
  const api: UseAgentChatApiOverride = { getSession, chatStream, stopChat, checkRunning }
  return { api, state, getSession, chatStream, stopChat, checkRunning }
}

beforeEach(() => { vi.restoreAllMocks() })

describe("useAgentChat stream-resume", () => {
  it("R1: mount probe sees running=true → resume mode; sending is blocked", async () => {
    const { api, chatStream } = makeHarness({ running: true })
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))

    await waitFor(() => expect(result.current.resumeStreaming).toBe(true))
    expect(result.current.streaming).toBe(true)

    // Input guard: sendMessage must not open a second stream (would 409 anyway)
    act(() => { void result.current.sendMessage("重头再发") })
    expect(chatStream).not.toHaveBeenCalled()

    // The streamed half lives in the LIVE area (same blocks as a local stream),
    // not in the transcript list — that's the 2026-10-29 switch-away-and-back
    // fix: it used to render as a settled message +「Agent 思考中」.
    await waitFor(() => expect(result.current.streamContent).toBe("server-side half"))
    expect(result.current.messages.some((m) => m.id === "a-partial")).toBe(false)
    expect(result.current.streamTimeline?.some((it) => it.kind === "text")).toBe(true)
    expect(result.current.streamingSessionId).toBe(SESSION_ID)
  })

  it("R2: poll observes running=false → exits resume, keeps finalized row", { timeout: 15000 }, async () => {
    const { api, state, getSession } = makeHarness({ running: true })
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await waitFor(() => expect(result.current.resumeStreaming).toBe(true))

    state.running = false
    await waitFor(() => expect(result.current.streaming).toBe(false), { timeout: 4000 })
    expect(result.current.resumeStreaming).toBe(false)
    expect(result.current.messages.map((m) => m.id)).toEqual(["a-partial"])

    // Poll truly stopped: no further fetches within 2 interval periods
    const callsAfterExit = getSession.mock.calls.length
    await new Promise((r) => setTimeout(r, 3200))
    expect(getSession.mock.calls.length).toBe(callsAfterExit)
  })

  it("R3: stop in resume mode → stopChat called, no local partial bubble, streaming held until poll exits", { timeout: 15000 }, async () => {
    const { api, state, stopChat } = makeHarness({ running: true })
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await waitFor(() => expect(result.current.resumeStreaming).toBe(true))

    // Simulate the server finalizing the aborted turn (running flips false).
    act(() => { state.running = false })
    await act(async () => { await result.current.stopGenerate() })

    expect(stopChat).toHaveBeenCalledWith(SESSION_ID)
    // Resume mode keeps streaming=true (input stays disabled) — the local
    // partial-append path must NOT fire (no duplicate `partial-` bubble;
    // the finalized interrupted row comes back through the poll).
    expect(result.current.streaming).toBe(true)
    expect(result.current.messages.some((m) => m.id.startsWith("partial-"))).toBe(false)

    await waitFor(() => expect(result.current.streaming).toBe(false), { timeout: 4000 })
    expect(result.current.messages.some((m) => m.id.startsWith("partial-"))).toBe(false)
  })

  it("R4: no checkRunning override → behavior identical to before (no resume, send works)", async () => {
    const { api, state, chatStream } = makeHarness({ running: true })
    delete api.checkRunning
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))

    // The server WOULD report running — but without the override the hook
    // never probes, so the main-agent consumers (ChatTab) keep old behavior.
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.streaming).toBe(false)
    expect(result.current.resumeStreaming).toBe(false)

    act(() => { void result.current.sendMessage("hello") })
    expect(chatStream).toHaveBeenCalledWith(SESSION_ID, "hello", expect.anything())
    expect(state.running).toBe(true) // untouched — no probe happened
  })

  it("R5: 409 STREAM_IN_PROGRESS on send → converts into resume mode, no error shown", { timeout: 15000 }, async () => {
    const { api, state, chatStream } = makeHarness({ running: false })
    // Turn the send into a bounced 409: transport error carrying the code.
    chatStream.mockImplementation(() => ({
      reader: {
        read: () => Promise.reject(
          Object.assign(new Error("该会话上一轮回复仍在生成中"), { code: "STREAM_IN_PROGRESS" }),
        ),
      } as unknown as ReadableStreamDefaultReader<Uint8Array>,
      abort: vi.fn(),
    } as unknown as AgentSSEConnection))

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await new Promise((r) => setTimeout(r, 50)) // let the (negative) mount probe settle
    expect(result.current.streaming).toBe(false)

    // Meanwhile the first turn is still generating server-side.
    state.running = true
    act(() => { void result.current.sendMessage("补发") })

    await waitFor(() => expect(result.current.resumeStreaming).toBe(true))
    // The bounce must not surface as an error banner.
    expect(result.current.error).not.toBe("该会话上一轮回复仍在生成中")

    // Clean exit so the interval doesn't outlive the assertions.
    state.running = false
    await waitFor(() => expect(result.current.streaming).toBe(false), { timeout: 4000 })
  })

  // 2026-10-29 用户：切换左侧任务会话后「全部都运行中」（实际任务已中止）。
  // 根因是侧栏按 activeSessionId 记运行态 —— 切换那一帧 streaming 还是旧会话的值。
  it("R6: switching sessions mid-stream never hands the running owner to the newly active session", async () => {
    const { api } = makeHarness({ running: false })
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useAgentChat(sid, { api }),
      { initialProps: { sid: "s-a" } },
    )
    await new Promise((r) => setTimeout(r, 20))

    act(() => { void result.current.sendMessage("hello") })
    expect(result.current.streamingSessionId).toBe("s-a")

    rerender({ sid: "s-b" })
    // The old stream is torn down; the new session must NEVER be labelled running.
    expect(result.current.streamingSessionId).not.toBe("s-b")
    await waitFor(() => expect(result.current.streaming).toBe(false))
    expect(result.current.streamingSessionId).toBe(null)
  })
})
