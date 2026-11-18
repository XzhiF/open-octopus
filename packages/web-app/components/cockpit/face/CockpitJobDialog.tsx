'use client'

// v21 七轮（用户）· 详情首签「对话」—— 这条作战的 chat 记录。
//
// 内容 = 任务主会话（task.source_chat_session_id）里的消息，用通讯台同一套
// TUI 转录件（TuiMessage）渲染 —— 转录只是换了个宿主，格式不另造。
// 只读：在这里不接 composer；要接着聊去通讯台（任务线程）。
// 没有主会话的作战（workflow / subagent）给明确空态，不拿执行账本冒充对话。
//
// 2026-11-19（用户：委托任务的 TUI chat 看不到 token/费用）：转录件的过程 meta
// 靠 message.turnStats，通讯台是 ChatPane 用会话账本算出来的；这里只拉消息，
// 于是 tok/¥ 永远不出现。现在同一节奏拉 /api/sessions/:id/llm-calls，用同一
// 个 buildTurnStats 挂回去 —— 换宿主不换口径。
//
// 2026-11-19（用户：详情对话里没渲染 AskUserQuestion）：任务作者的提问落在
// tool_calls 里，旧转录只画正文 → 卡片不见。这里给 TuiMessage 传 ask 绑定，
// 用 useAskSubmit 接真决策管线；答完本地先标记已答，10s 轮询再对齐服务端。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSession } from '@/lib/agent/api'
import type { AgentMessage } from '@/lib/agent/types'
import { useSessionLedger } from '@/hooks/useSessionLedger'
import { buildTurnStats } from '@/lib/turn-stats'
import { useAskSubmit } from '@/components/cabin/asks/ask-submit'
import { TuiMessage, lastAskCallOf } from '@/components/agent/chat/TuiTranscript'

/** 与详情其它页签同节奏：10s 拉一次快照（运行中的作战也能看到新记录）。 */
const DIALOG_POLL_MS = 10_000
/** 「贴底」阈值：离底部 24px 以内都算在看最新，新内容可以继续跟。 */
const STICK_SLACK_PX = 24

export interface CockpitJobDialogProps {
  /** 任务主会话 id；workflow / subagent 作业没有 → null。 */
  sessionId: string | null
  /** 作答要回哪个舱的决策端点（缺省 = 卡片只读，不给提交）。 */
  cabinId?: string | null
  /** 归属任务（决策回执用；缺省不带）。 */
  taskId?: string | null
}

/** 一条消息 + 它自己的提问提交管线（有 AskUserQuestion 才真正用到）。 */
function DialogMessage({
  message, cabinId, taskId, answered, onAnswered,
}: {
  message: AgentMessage
  cabinId: string | null
  taskId: string | null
  answered: boolean
  onAnswered: (id: string) => void
}) {
  const askCall = useMemo(() => lastAskCallOf(message), [message])
  const optionLabels = useMemo(() => {
    const list = (askCall?.input as { questions?: unknown } | null)?.questions
    if (!Array.isArray(list)) return [] as string[]
    const first = list[0] as { options?: Array<{ label?: unknown }> } | undefined
    if (!Array.isArray(first?.options)) return [] as string[]
    return first.options
      .map((option) => (typeof option?.label === 'string' ? option.label : ''))
      .filter((label): label is string => !!label)
  }, [askCall])

  const { submit, busy, failed } = useAskSubmit({
    cabinId,
    // 服务端把「无镜像卡的原卡」的 askId 记成消息行 id（cabin-service 兜底信封）。
    askId: message.id,
    ...(taskId ? { taskId } : {}),
    optionLabels,
    messageId: message.id,
    threadFallback: false,
  })

  // 没有舱上下文就没有决策端点 —— 宁可不铺卡片，也不给一张点了没用的卡。
  const ask = askCall && cabinId
    ? {
        onAnswer: (content: string) => {
          void submit(content).then((outcome) => {
            if (outcome.ok) onAnswered(message.id)
          })
        },
        busy,
        answered,
        error: failed,
      }
    : undefined

  return <TuiMessage message={message} ask={ask} />
}

export function CockpitJobDialog({ sessionId, cabinId = null, taskId = null }: CockpitJobDialogProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stuckRef = useRef(true)
  // 逐轮 token/费用：账本按会话拉，消息条数变化（轮询发现新轮）即重拉一次。
  const { calls } = useSessionLedger(sessionId, false, messages.length)

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

  // 挂回逐轮统计（与通讯台同一口径）；账本还没到位时原样渲染，不闪占位。
  const viewMessages = useMemo(() => {
    if (messages.length === 0 || calls.length === 0) return messages
    const stats = buildTurnStats(messages, calls)
    if (stats.size === 0) return messages
    return messages.map((message) => {
      const turnStats = stats.get(message.id)
      return turnStats ? { ...message, turnStats } : message
    })
  }, [messages, calls])

  // 已答判定：提问消息之后出现「用户回答了以下问题」= 这轮答过了（与 classic
  // 问答窗同一判据）。本地答完先乐观标记，不等 10s 轮询。
  const [justAnswered, setJustAnswered] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => { setJustAnswered(new Set()) }, [sessionId])
  const answeredAsks = useMemo(() => {
    const done = new Set<string>(justAnswered)
    let pending: string[] = []
    for (const message of messages) {
      if (message.role === 'assistant' && lastAskCallOf(message)) pending.push(message.id)
      else if (message.role === 'user' && message.content.includes('用户回答了以下问题')) {
        for (const id of pending) done.add(id)
        pending = []
      }
    }
    return done
  }, [messages, justAnswered])
  const markAnswered = useCallback((id: string) => {
    setJustAnswered((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  return (
    <div className="ck12-dcon" data-testid="cockpit-dialog">
      <div className="ck12-dcon-h">
        <b>✦ 任务对话</b>
        <span className="n">
          {messages.length} 条 · {turns} 轮提问 · {cabinId ? '记录只读 · 提问可就地回答' : '只读记录'}
        </span>
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
        ) : viewMessages.length === 0 ? (
          <div className="ck12-face-empty">这条作战还没有对话记录。</div>
        ) : (
          viewMessages.map((message) => (
            <DialogMessage
              key={message.id}
              message={message}
              cabinId={cabinId}
              taskId={taskId}
              answered={answeredAsks.has(message.id)}
              onAnswered={markAnswered}
            />
          ))
        )}
      </div>
    </div>
  )
}
