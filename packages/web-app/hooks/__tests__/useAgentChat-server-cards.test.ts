// packages/web-app/hooks/__tests__/useAgentChat-server-cards.test.ts
//
// 2026-10-30 用户 bug：任务作者在对话里说「启动决策卡也已经发给你」，但对话中
// 看不到「立即执行 / 入列待触发 / 定时触发」这些选项。
//
// 根因：那类卡是任务工具在**本轮服务端侧**追加到 messages 表的（role=user,
// metadata.displayType='event'），从不走 SSE；onDone 只把助手正文拼进本地
// messages，从不回读 —— 卡片要等手动刷新才出现。
//
// 现在：done 到达后按「已收尾的一轮」重拉实录，服务端追加的事件卡直接入列。

import { describe, it, expect, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAgentChat, type UseAgentChatApiOverride } from "../useAgentChat"
import type { AgentMessage, AgentSession } from "@/lib/agent/types"
import type { AgentSSEConnection } from "@/lib/agent/api"

const SESSION_ID = "s-server-card-1"

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

/** 一条 done 帧就收尾的假流（下一轮 read 永远挂起）。 */
function doneStream(messageId: string): AgentSSEConnection {
  const frame = `event: done\ndata: ${JSON.stringify({
    session_id: SESSION_ID, message_id: messageId, session_title: null,
  })}\n\n`
  let served = false
  return {
    reader: {
      read: async () => {
        if (served) return new Promise(() => {})
        served = true
        return { done: false, value: new TextEncoder().encode(frame) }
      },
    },
    abort: vi.fn(),
  } as unknown as AgentSSEConnection
}

describe("useAgentChat server-appended cards", () => {
  it("done 之后重拉实录：本轮服务端追加的事件卡（启动决策）出现在 messages 里", async () => {
    const before = [
      row({ id: "u-1", role: "user", content: "开发脱敏工具类" }),
    ]
    const after = [
      ...before,
      row({ id: "a-1", role: "assistant", content: "规格已全部落地。" }),
      row({
        id: "ev-launch",
        role: "user",
        content: "[任务工具 · task.launch_proposal] 启动方式待选择",
        displayType: "event",
        activity: {
          kind: "task.launch_proposal",
          severity: "info",
          title: "启动方式待选择",
          taskId: "task-1",
          actions: [
            { id: "launch_now", label: "立即执行" },
            { id: "enqueue", label: "入列，等我手动触发" },
            { id: "schedule", label: "定时触发…" },
          ],
        },
      } as Partial<AgentMessage> & { id: string; role: AgentMessage["role"] }),
    ]

    let turnDone = false
    const getSession = vi.fn(async () => ({
      session: { id: SESSION_ID } as unknown as AgentSession,
      messages: { items: turnDone ? after : before, total: 2, has_more: false, next_cursor: null },
    }))
    const chatStream = vi.fn(() => doneStream("a-1"))
    const api: UseAgentChatApiOverride = {
      getSession,
      chatStream,
      stopChat: vi.fn(async () => ({ success: true })),
      checkRunning: vi.fn(async () => ({ running: false, partial: false })),
    }

    const { result } = renderHook(() => useAgentChat(SESSION_ID, { api }))
    // 挂载不自动读库（ChatTab 负责首载）；这里手动补一次基线。
    await act(async () => { await result.current.loadMessages() })
    expect(result.current.messages.length).toBe(1)

    act(() => { void result.current.sendMessage("开发脱敏工具类") })
    expect(result.current.streaming).toBe(true)

    // 服务端在这轮里追加了决策卡（messages 表新增一行）。
    turnDone = true

    await waitFor(() => {
      const card = result.current.messages.find((m) => m.id === "ev-launch")
      expect(card?.displayType).toBe("event")
      expect(card?.activity?.actions?.map((a) => a.id)).toEqual(["launch_now", "enqueue", "schedule"])
    })
    expect(result.current.streaming).toBe(false)
  })
})
