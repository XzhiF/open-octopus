// packages/web-app/components/tasks/run-console/ready-chat-replay.tsx
//
// 票08 — ready 控制台「💬 对话」签：草稿期会话（task.source_chat_session_id）
// 全史**只读回放**。真相源 = 原型 taskboard-v2.html ⓬ readyChatHtml：顶部 dim
// 水印「— 只读回放 · 草稿期对话（task-author 全记录）—」+ 整屏 transcript
// （用户/agent 气泡按到达序）。形制与草稿工作台同：复用 TuiTranscript.TuiMessage，
// thinking/工具折叠 meta 全继承（thinking 全文展开、工具 input/result 展开 ——
// 2026-10-10 刚做的两枚交互白拿）。
//
// 取数 = useAgentChat 的历史通路（api.getSession override）挂
// getAuthorSessionReplay：与草稿工作台同端点（GET /api/clones/task-author/
// sessions/:id）同解析，before 游标自持翻页取全量，上限 1000 条超限截断并如实
// 标注（分页/上限纪律与注释在 lib/agent/api.ts 取数层）。服务端零新端点。
//
// 只读硬闸：本面没有任何输入区/dock —— 要说话回草稿或待验收期（票07 裁决）。
// 组件从不渲染可输入元素；不注入 chatStream/stopChat/checkRunning（无发送通道、
// 无恢复轮询），对话内容任何路径不可写。
//
// 空态三档（票面 AC3）：sessionId 缺失 / 取数 404（会话已清理）→ 同一文案
// 「草稿期会话不存在」，不白屏；会话存在但零消息 → 水印 + 如实「暂无消息」；
// 其它读取失败 → 如实「读取失败」话术，不伪装成空态。

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { AgentSession } from "@/lib/agent/types"
import { getAuthorSessionReplay, SESSION_REPLAY_MAX } from "@/lib/agent/api"
import { useAgentChat } from "@/hooks/useAgentChat"
import { TuiMessage } from "@/components/agent/chat/TuiTranscript"

/** 水印逐字 = 原型 readyChatHtml .replay-hd。 */
const WATERMARK = "— 只读回放 · 草稿期对话（task-author 全记录）—"

type ReplayState = "loading" | "ready" | "empty" | "failed"

export function ReadyChatReplay({ sessionId }: { sessionId: string | null | undefined }) {
  const [state, setState] = useState<ReplayState>(sessionId ? "loading" : "empty")
  const [truncated, setTruncated] = useState(false)

  const api = useMemo(() => ({
    getSession: async (id: string) => {
      try {
        const res = await getAuthorSessionReplay(id)
        setTruncated(res.truncated)
        setState("ready")
        // hook 只消费 messages.items；session 面回放用不上，给形状即可（不另发请求）。
        return {
          session: { id } as AgentSession,
          messages: { items: res.items, total: res.items.length, has_more: false, next_cursor: null },
        }
      } catch (err) {
        // 404 = 会话不存在/已清理 → 与「无缝」同空态；其它错误如实报读取失败。
        setState((err as { status?: number }).status === 404 ? "empty" : "failed")
        return { session: { id } as AgentSession, messages: { items: [], total: 0, has_more: false, next_cursor: null } }
      }
    },
    // 只读面：不注入 chatStream/stopChat/checkRunning —— 发送与恢复通道根本不存在。
  }), [])
  const chat = useAgentChat(sessionId ?? null, { api })

  // 与会话历史通路同纪律（authoring-workspace 式）：每会话只载一次；换任务重挂载自然重来。
  const loadedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!sessionId) { setState("empty"); return }
    if (loadedRef.current.has(sessionId)) return
    loadedRef.current.add(sessionId)
    setTruncated(false)
    setState("loading")
    void chat.loadMessages()
  }, [sessionId, chat])

  // id 去重（同 ChatArea 挂载纪律，防历史行双现）。
  const messages = useMemo(
    () => Array.from(new Map(chat.messages.map((m) => [m.id, m])).values()),
    [chat.messages],
  )

  if (!sessionId || state === "empty") {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="ready-chat-replay" data-replay-state="empty">
        <div
          className="mx-auto mt-10 max-w-[560px] rounded-xl border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-6 py-8 text-center font-mono text-[11px] leading-relaxed text-pop-dim"
          data-testid="ready-chat-empty"
        >
          <div className="mb-1 font-black text-pop-ink">草稿期会话不存在</div>
          该任务没有草稿期对话记录（或会话已清理）—— 要看创作过程，请退回草稿期打开对话工作台。
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ready-chat-replay" data-replay-state={state} data-readonly="true">
      {/* 顶部 dim 水印（原型 .replay-hd：居中 + 虚线底边） */}
      <div
        className="shrink-0 border-b-[1.5px] border-dashed border-pop-bd px-4 pb-2.5 pt-3 text-center font-mono text-[10px] text-pop-dim"
        data-testid="ready-chat-watermark"
      >
        {WATERMARK}
      </div>
      {state === "loading" && (
        <div className="px-4 py-6 text-center font-mono text-[11px] text-pop-dim">回放读取中…</div>
      )}
      {state === "failed" && (
        <div className="mx-4 mt-3 rounded-[10px] border-[1.5px] border-pop-bd bg-pop-amber-soft px-3 py-2 font-mono text-[10.5px] font-black text-pop-amber" data-testid="ready-chat-error">
          回放读取失败 —— 服务端暂不可达；稍后重开控制台再试（不伪造空会话）。
        </div>
      )}
      {state === "ready" && (
        <>
          {/* 上限截断如实标注（取全量注上限，见 lib/agent/api.ts 取数层注释） */}
          {truncated && (
            <div className="px-4 pt-2 text-center font-mono text-[10px] text-pop-amber" data-testid="ready-chat-truncated">
              会话超长：仅回放最近 {SESSION_REPLAY_MAX} 条，更早的消息未纳入回放
            </div>
          )}
          {/* 整屏 transcript（原型 .replay{max-width:820px} + 草稿工作台 TUI 形制）；
              滚动到底部即止 —— 这里没有 dock，也没有输入框。 */}
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="ready-chat-log">
            {messages.length === 0 ? (
              <div className="px-4 py-6 text-center font-mono text-[11px] text-pop-dim" data-testid="ready-chat-nomsg">
                — 草稿期会话暂无消息 —
              </div>
            ) : (
              <div className="mx-auto max-w-[820px] space-y-1.5 px-5 py-4 font-mono text-[12.5px] leading-relaxed">
                {messages.map((m) => <TuiMessage key={m.id} message={m} />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
