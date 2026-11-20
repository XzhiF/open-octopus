// packages/web-app/hooks/__tests__/useAgentChat-paging.test.ts
//
// 2026-11-20 用户 #11：转录要上限 + 上翻分页。锁四条：
//   1. 首屏只取最近一页（MESSAGE_PAGE_SIZE），has_more 透出给 UI；
//   2. loadOlderMessages 以当前最早一条 created_at 为游标，页面前插；
//   3. 到达最早已无更早 → 不再发请求；
//   4. 轮末补拉最新一页时，已上翻加载的历史不被冲掉。
import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useAgentChat, MESSAGE_PAGE_SIZE, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage } from "@/lib/agent/types"

const SESSION_ID = "s-paging-1"

function msg(id: string, minute: number, role: "user" | "assistant" = "user", content = id): AgentMessage {
  return {
    id,
    session_id: SESSION_ID,
    role,
    content,
    created_at: `2026-11-20T06:${String(minute).padStart(2, "0")}:00.000Z`,
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  }
}

function page(items: AgentMessage[], hasMore: boolean) {
  return {
    session: { id: SESSION_ID } as never,
    messages: { items, total: items.length, has_more: hasMore, next_cursor: hasMore ? items[0]?.created_at ?? null : null },
  }
}

describe("useAgentChat — 转录分页", () => {
  it("首屏只取一页，has_more 透出", async () => {
    const getSession = vi.fn().mockResolvedValue(page([msg("m-101", 50)], true))
    const api = { getSession } as unknown as UseAgentChatApiOverride
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))

    await act(async () => { await result.current.loadMessages() })

    expect(getSession).toHaveBeenCalledWith(SESSION_ID, { limit: MESSAGE_PAGE_SIZE })
    expect(result.current.hasMoreMessages).toBe(true)
    expect(result.current.messages.map((m) => m.id)).toEqual(["m-101"])
  })

  it("上翻一页：用最早一条 created_at 作游标，页面前插", async () => {
    const latest = [msg("m-101", 50), msg("m-102", 51, "assistant")]
    const older = [msg("m-1", 1), msg("m-2", 2, "assistant")]
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(page(latest, true))
      .mockResolvedValueOnce(page(older, false))
    const api = { getSession } as unknown as UseAgentChatApiOverride
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))

    await act(async () => { await result.current.loadMessages() })
    await act(async () => { await result.current.loadOlderMessages() })

    expect(getSession).toHaveBeenLastCalledWith(SESSION_ID, { limit: MESSAGE_PAGE_SIZE, cursor: latest[0].created_at })
    expect(result.current.messages.map((m) => m.id)).toEqual(["m-1", "m-2", "m-101", "m-102"])
    expect(result.current.hasMoreMessages).toBe(false)
  })

  it("到最早已无更早 → 不再发请求", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(page([msg("m-1", 1)], false))
    const api = { getSession } as unknown as UseAgentChatApiOverride
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))

    await act(async () => { await result.current.loadMessages() })
    expect(result.current.hasMoreMessages).toBe(false)

    await act(async () => { await result.current.loadOlderMessages() })
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("补拉最新一页时保住已加载的更早历史", async () => {
    const latest = [msg("m-101", 50), msg("m-102", 51, "assistant")]
    const older = [msg("m-1", 1), msg("m-2", 2, "assistant")]
    const refreshed = [...latest, msg("m-103", 52, "assistant")]
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(page(latest, true))
      .mockResolvedValueOnce(page(older, false))
      .mockResolvedValueOnce(page(refreshed, true))
    const api = { getSession } as unknown as UseAgentChatApiOverride
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))

    await act(async () => { await result.current.loadMessages() })
    await act(async () => { await result.current.loadOlderMessages() })
    await act(async () => { await result.current.loadMessages() })

    expect(result.current.messages.map((m) => m.id)).toEqual(["m-1", "m-2", "m-101", "m-102", "m-103"])
  })
})
