// 刷新后自动回到上次的会话（bug 2026-10-27）。
//
// 旧行为：activeSessionId 初始 null，列表回来后一律选「最新的 main 会话」。
// 正在跑的 task-author / clone 会话因此被丢掉，用户必须再点一次才看得到运行中。
// 现在：列表回来先认落盘的 session；只有它不存在时才回退到最新 main。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

vi.mock("@/lib/agent/api", () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
}))

import * as api from "@/lib/agent/api"
import { useAgentSessions } from "../useAgentSessions"
import { writeLastChatContext } from "@/lib/last-chat-context"

const mainNew = {
  id: "s-main", title: "最新主对话", org: "xzf", clone_name: null,
  perspective_clone_name: null, session_type: "main", created_at: "2026-10-27T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z", last_message_at: "2026-10-27T10:00:00Z", is_active: true,
}
const authorOld = {
  ...mainNew, id: "s-author", title: "任务草稿", clone_name: "task-author",
  session_type: "delegate", last_message_at: "2026-10-27T09:00:00Z",
}

const mockList = vi.mocked(api.listSessions)
const mockCreate = vi.mocked(api.createSession)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockList.mockResolvedValue({ items: [mainNew, authorOld], total: 2 } as never)
  mockCreate.mockResolvedValue({ ...mainNew, id: "s-new" } as never)
})

describe("useAgentSessions — 刷新恢复", () => {
  it("有落盘的 session ⇒ 恢复它（哪怕不是最新、哪怕是 clone 会话）", async () => {
    writeLastChatContext({ kind: "session", sessionId: "s-author" })
    const { result } = renderHook(() => useAgentSessions())

    await waitFor(() => expect(result.current.activeSessionId).toBe("s-author"))
  })

  it("没有落盘 ⇒ 沿用旧行为：最新 main 会话", async () => {
    const { result } = renderHook(() => useAgentSessions())

    await waitFor(() => expect(result.current.activeSessionId).toBe("s-main"))
  })

  it("落盘的 session 已不存在 ⇒ 回退到最新 main", async () => {
    writeLastChatContext({ kind: "session", sessionId: "s-gone" })
    const { result } = renderHook(() => useAgentSessions())

    await waitFor(() => expect(result.current.activeSessionId).toBe("s-main"))
  })

  it("落盘的是任务上下文 ⇒ 会话侧不抢（交给 ChatTab 按任务恢复）", async () => {
    writeLastChatContext({ kind: "task", taskId: "t1" })
    const { result } = renderHook(() => useAgentSessions())

    await waitFor(() => expect(result.current.activeSessionId).toBe("s-main"))
  })

  it("createNewSession 落盘新会话，下一次刷新停在它上面", async () => {
    const { result } = renderHook(() => useAgentSessions())
    await waitFor(() => expect(result.current.activeSessionId).toBe("s-main"))

    await act(async () => {
      await result.current.createNewSession()
    })

    expect(result.current.activeSessionId).toBe("s-new")
    expect(localStorage.getItem("octopus.chat.lastContext.v1")).toBe(
      JSON.stringify({ kind: "session", sessionId: "s-new" }),
    )
  })
})
