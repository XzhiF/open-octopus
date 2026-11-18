'use client'

// v21 七轮（用户）· 详情首签「对话」—— 这条作战的 chat 记录。
//
// 内容 = 任务主会话（task.source_chat_session_id）里的消息，用通讯台同一套
// TUI 转录件（TuiMessage）渲染 —— 转录只是换了个宿主，格式不另造。
// 只读：在这里不接 composer；要接着聊去通讯台（任务线程）。
// 没有主会话的作战（workflow / subagent）给明确空态，不拿执行账本冒充对话。

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession } from '@/lib/agent/api'
import type { AgentMessage } from '@/lib/agent/types'
import { TuiMessage } from '@/components/agent/chat/TuiTranscript'

/** 与详情其它页签同节奏：10s 拉一次快照（运行中的作战也能看到新记录）。 */
const DIALOG_POLL_MS = 10_000
/** 「贴底」阈值：离底部 24px 以内都算在看最新，新内容可以继续跟。 */
const STICK_SLACK_PX = 24

export interface CockpitJobDialogProps {
  /** 任务主会话 id；workflow / subagent 作业没有 → null。 */
  sessionId: string | null
}

export function CockpitJobDialog({ sessionId }: CockpitJobDialogProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stuckRef = useRef(true)

  const load = useCallback(async () => {
    if (!sessionId) return
    try {
      const session = await getSession(sessionId, { limit: 200 })
      setMessages(session.messages.items)
      setError(null)
    } catch {
      // 保留上一份快照，只给一行原因；不让整段对话闪掉。
      setError('对话记录载入失败')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setMessages([])
    setError(null)
    stuckRef.current = true
    if (!sessionId) return
    setLoading(true)
    void load()
    const timer = window.setInterval(() => { void load() }, DIALOG_POLL_MS)
    return () => window.clearInterval(timer)
  }, [load, sessionId])

  // 贴底跟 chat 一致：默认停在最新一条；人往上翻后新内容不抢滚动。
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stuckRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX
  }, [])

  // 轮提问只数人说的话 —— 事件卡也是 user 角色，但它们不是提问。
  const turns = messages.filter(
    (message) => message.role === 'user' && message.displayType !== 'event',
  ).length

  return (
    <div className="ck12-dcon" data-testid="cockpit-dialog">
      <div className="ck12-dcon-h">
        <b>✦ 任务对话</b>
        <span className="n">{messages.length} 条 · {turns} 轮提问 · 只读记录</span>
      </div>
      <div
        ref={bodyRef}
        className="ck12-dcon-log"
        data-testid="cockpit-dialog-log"
        onScroll={onScroll}
      >
        {!sessionId ? (
          <div className="ck12-face-empty">
            这条作业没有关联的对话会话（工作流 / 子代理作业只走执行账本）。
          </div>
        ) : error && messages.length === 0 ? (
          <div className="ck12-face-empty">{error}</div>
        ) : loading && messages.length === 0 ? (
          <div className="ck12-face-empty">载入对话记录…</div>
        ) : messages.length === 0 ? (
          <div className="ck12-face-empty">这条作战还没有对话记录。</div>
        ) : (
          messages.map((message) => <TuiMessage key={message.id} message={message} />)
        )}
      </div>
    </div>
  )
}
