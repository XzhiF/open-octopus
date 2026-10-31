// packages/web-app/hooks/__tests__/useAgentChat-context-cache.test.ts
//
// ctx 角标的冷启动来源。上下文用量是轮次级数据，客户端算不出来：
//   - 首屏 = localStorage 缓存（同浏览器刷新/重开，立即上屏，避免闪 --%）
//   - 权威值 = 会话详情响应里服务端持久化的 context_usage（刷新 / 重启服务 /
//     换浏览器都成立）
// 这里锁住两条读取路径：缓存恢复（含 sessionStorage 迁移）与服务端播种。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { ContextUsageData } from "@/lib/agent/types"
import type { AgentSSEConnection } from "@/lib/agent/api"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"

const SESSION_ID = "s-ctx-1"

const CTX: ContextUsageData = {
  categories: [{ name: "System prompt", tokens: 12000, color: "#888" }],
  totalTokens: 32800,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 16.4,
  model: "claude-sonnet-4-5",
}

const SERVER_CTX: ContextUsageData = { ...CTX, totalTokens: 64000, percentage: 32 }

function apiWithSession(sessionExtra: Record<string, unknown>, nested = false): UseAgentChatApiOverride {
  return {
    getSession: vi.fn(async () => ({
      ...(nested ? {} : sessionExtra),
      session: { id: SESSION_ID, ...(nested ? sessionExtra : {}) } as never,
      messages: { items: [], total: 0, has_more: false, next_cursor: null },
    })),
    chatStream: vi.fn(() => ({
      reader: { read: () => new Promise(() => {}) },
      abort: vi.fn(),
    } as unknown as AgentSSEConnection)),
    stopChat: vi.fn(async () => ({})),
  }
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe("useAgentChat contextUsage cold load", () => {
  it("restores from the localStorage cache on a cold mount", () => {
    window.localStorage.setItem(`context-usage:${SESSION_ID}`, JSON.stringify(CTX))
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api: apiWithSession({}) }))
    expect(result.current.contextUsage?.percentage).toBe(16.4)
  })

  it("restores when sessionId goes null → id after mount", () => {
    window.localStorage.setItem(`context-usage:${SESSION_ID}`, JSON.stringify(CTX))
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | null }) => useAgentChat(sid, { api: apiWithSession({}) }),
      { initialProps: { sid: null as string | null } },
    )
    expect(result.current.contextUsage).toBeNull()
    rerender({ sid: SESSION_ID })
    expect(result.current.contextUsage?.percentage).toBe(16.4)
  })

  it("promotes a legacy sessionStorage value to localStorage on read", () => {
    window.sessionStorage.setItem(`context-usage:${SESSION_ID}`, JSON.stringify(CTX))
    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api: apiWithSession({}) }))
    expect(result.current.contextUsage?.percentage).toBe(16.4)
    expect(window.localStorage.getItem(`context-usage:${SESSION_ID}`)).toBeTruthy()
  })

  it("seeds from the server session payload (main route: flat response) and caches it", async () => {
    const { result } = renderHook(() => useAgentChat(SESSION_ID, {
      api: apiWithSession({ context_usage: SERVER_CTX }),
    }))
    await act(async () => { await result.current.loadMessages() })
    await waitFor(() => expect(result.current.contextUsage?.percentage).toBe(32))
    expect(JSON.parse(window.localStorage.getItem(`context-usage:${SESSION_ID}`) ?? "null").percentage).toBe(32)
  })

  it("seeds from the nested clone-session shape too", async () => {
    const { result } = renderHook(() => useAgentChat(SESSION_ID, {
      api: apiWithSession({ context_usage: SERVER_CTX }, true),
    }))
    await act(async () => { await result.current.loadMessages() })
    await waitFor(() => expect(result.current.contextUsage?.percentage).toBe(32))
  })

  it("server value wins over a stale local cache", async () => {
    window.localStorage.setItem(`context-usage:${SESSION_ID}`, JSON.stringify(CTX))
    const { result } = renderHook(() => useAgentChat(SESSION_ID, {
      api: apiWithSession({ context_usage: SERVER_CTX }),
    }))
    await act(async () => { await result.current.loadMessages() })
    await waitFor(() => expect(result.current.contextUsage?.percentage).toBe(32))
  })

  it("malformed server payloads are ignored (cache survives)", async () => {
    window.localStorage.setItem(`context-usage:${SESSION_ID}`, JSON.stringify(CTX))
    const { result } = renderHook(() => useAgentChat(SESSION_ID, {
      api: apiWithSession({ context_usage: { model: "pro" } }),
    }))
    await act(async () => { await result.current.loadMessages() })
    expect(result.current.contextUsage?.percentage).toBe(16.4)
  })
})
