'use client'

// 待回答收件箱（design 23 §2 续 · 2026-11-16）
//
// 编队里多个任务可能同时来问（作者提问卡并发投进舱主会话），用户要先**挑一条**
// 处理，而不是在长转录里翻。这里在对话顶端给一个粘性条：每条待答一行
// （任务名 + 第一个问题），点一行就把对应的就地作答卡滚到视野里。
//
// 数据源就是当前会话的消息（零额外请求）；答完后卡片本地就会带 decision，
// 这里再监听 octopus:author-ask-answered 立即消项，不必等刷新。

import { useEffect, useMemo, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import type { AgentMessage } from '@/lib/agent/types'

interface AuthorAskPayload {
  authorAsk?: boolean
  askMessageId?: string
  taskId?: string
  taskName?: string
  questions?: unknown
}

export interface PendingAuthorAsk {
  askMessageId: string
  taskId: string | null
  taskName: string
  question: string
}

function firstQuestion(questions: unknown): string {
  let raw = questions
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return '' }
  }
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return ''
  const first = list[0] as { question?: unknown; header?: unknown } | undefined
  if (typeof first?.question === 'string') return first.question
  if (typeof first?.header === 'string') return first.header
  return ''
}

/** 当前会话里所有「作者在问、尚未回答」的卡（按出现顺序）。 */
export function pendingAuthorAsks(messages: AgentMessage[]): PendingAuthorAsk[] {
  const out: PendingAuthorAsk[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    const payload = (m.activity?.payload ?? {}) as AuthorAskPayload
    if (!payload.authorAsk) continue
    if (m.activity?.decision) continue
    const askMessageId = payload.askMessageId ?? m.id
    if (seen.has(askMessageId)) continue
    seen.add(askMessageId)
    out.push({
      askMessageId,
      taskId: payload.taskId ?? null,
      taskName: payload.taskName ?? '任务',
      question: firstQuestion(payload.questions),
    })
  }
  return out
}

export function AuthorAskInbox({ messages }: { messages: AgentMessage[] }) {
  const [answeredIds, setAnsweredIds] = useState<Set<string>>(() => new Set())
  const pending = useMemo(
    () => pendingAuthorAsks(messages).filter((p) => !answeredIds.has(p.askMessageId)),
    [messages, answeredIds],
  )

  useEffect(() => {
    const onAnswered = (event: Event) => {
      const id = (event as CustomEvent<{ askMessageId?: string }>).detail?.askMessageId
      if (!id) return
      setAnsweredIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
    }
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ askMessageId?: string }>).detail?.askMessageId
      if (!id) return
      const target = document.getElementById(`author-ask-${id}`)
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.classList.add('ring-2', 'ring-pop-amber')
      window.setTimeout(() => target.classList.remove('ring-2', 'ring-pop-amber'), 1_800)
    }
    window.addEventListener('octopus:author-ask-answered', onAnswered)
    window.addEventListener('octopus:open-ask', onOpen)
    return () => {
      window.removeEventListener('octopus:author-ask-answered', onAnswered)
      window.removeEventListener('octopus:open-ask', onOpen)
    }
  }, [])

  if (pending.length === 0) return null

  const jump = (id: string) =>
    window.dispatchEvent(new CustomEvent('octopus:open-ask', { detail: { askMessageId: id } }))

  return (
    <div
      data-testid="author-ask-inbox"
      className="sticky top-0 z-20 mb-2 rounded-lg border-2 border-pop-amber/60 bg-pop-amber-soft/95 px-2.5 py-1.5 shadow-pop backdrop-blur"
    >
      <div className="flex items-center gap-2 text-[11px] font-bold text-pop-amber">
        <MessageSquare className="size-3" aria-hidden />
        {pending.length} 个任务在等你回答 · 选一条处理
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {pending.map((item) => (
          <button
            key={item.askMessageId}
            type="button"
            data-testid="author-ask-inbox-row"
            onClick={() => jump(item.askMessageId)}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-[11.5px] transition-colors hover:bg-white/10"
          >
            <span className="max-w-[38%] truncate font-semibold text-pop-ink">{item.taskName}</span>
            <span className="min-w-0 flex-1 truncate text-pop-dim">{item.question || '（打开卡片看问题）'}</span>
            <span className="shrink-0 text-[10px] font-bold text-pop-cyan">回答 →</span>
          </button>
        ))}
      </div>
    </div>
  )
}
