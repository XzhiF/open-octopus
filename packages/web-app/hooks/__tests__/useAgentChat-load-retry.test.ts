// packages/web-app/hooks/__tests__/useAgentChat-load-retry.test.ts
//
// 2026-10-30 用户 bug：回答 AskUserQuestion 卡片后补拉实录，单次 fetch 被
// 网络层拒绝（浏览器报成 CORS / ERR_FAILED），「Failed to load messages」
// 红条就此常驻，哪怕后面每次重拉都成功。这里锁三条：
//   1. 无 status 的网络失败 → 静默重试一次，成功即正常出消息；
//   2. 连败两次才报错；
//   3. 任何一次成功加载都会清掉旧横幅。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage } from "@/lib/agent/types"

const SESSION_ID = "s-load-retry-1"

function sessionPayload(text: string) {
  return {
    session: { id: SESSION_ID } as never,
    messages: {
      items: [
        {
          id: "m-1",
          session_id: SESSION_ID,
          role: "assistant" as const,
          content: text,
          is_summary: false,
          is_compressed: false,
          is_edited: false,
          created_at: "2026-10-30T06:41:28.188Z",
        } satisfies AgentMessage,
      ],
      total: 1,
      has_more: false,
      next_cursor: null,
    },
  }
}

/** fetch() rejection shape: TypeError with no HTTP status. */
const networkError = () => new TypeError("Failed to fetch")

beforeEach(() => { vi.restoreAllMocks() })

describe("useAgentChat — 实录加载失败恢复", () => {
  it("一次网络失败 → 静默重试成功，不出错、出消息", async () => {
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(sessionPayload("重试回来的实录"))
    const api = { getSession } as unknown as UseAgentChatApiOverride

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await act(async () => { await result.current.loadMessages() })

    expect(getSession).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("重试回来的实录"))
  })

  it("连败两次才报 Failed to load messages", async () => {
    const getSession = vi.fn().mockRejectedValue(networkError())
    const api = { getSession } as unknown as UseAgentChatApiOverride

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await act(async () => { await result.current.loadMessages() })

    expect(getSession).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBe("Failed to load messages")
  })

  it("后续加载成功 → 旧横幅自动消失", async () => {
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(sessionPayload("恢复"))
    const api = { getSession } as unknown as UseAgentChatApiOverride

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    await act(async () => { await result.current.loadMessages() })
    expect(result.current.error).toBe("Failed to load messages")

    await act(async () => { await result.current.loadMessages() })
    expect(result.current.error).toBeNull()
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("恢复"))
  })
})
