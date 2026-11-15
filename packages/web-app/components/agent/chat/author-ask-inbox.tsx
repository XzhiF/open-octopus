'use client'

// 决策队列（design 23 §2 续 → design 25 §5.3 / §5.6）
//
// 编队里多条 attention 同时来是常态。这里在转录顶端给一个粘性条：
//   · 按 handle 分组列出待决项，扫一眼就知道在跟哪条线说话；
//   · 同屏最多 3 条展开，其余折成「+N 条待处理」；
//   · 键盘 1/2/3 选当前卡的选项、↵ 提交；提交后焦点自动下一条；
//   · 焦点条常驻：「正在回答 #1 支付回调」，切任务变成一次显式操作而不是滚动。
//
// 归属永远由卡片 payload 里的 askId 决定（票据），焦点只是 UI 提示。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare, X } from 'lucide-react'
import type { AgentMessage } from '@/lib/agent/types'

interface AuthorAskPayload {
  authorAsk?: boolean
  askMessageId?: string
  taskId?: string
  taskName?: string
  handle?: string
  taskHandle?: string
  subject?: { kind: 'task' | 'delegation'; id: string }
  decision?: string
  blocking?: boolean
  questions?: unknown
}

export interface PendingAuthorAsk {
  askMessageId: string
  taskId: string | null
  taskName: string
  question: string
  handle: string
  subjectKind: 'task' | 'delegation'
  subjectId: string | null
  /** 信封里的「要定的事」——队列行优先显示它，比问题标题更能说明要拍什么。 */
  decision: string
  blocking: boolean
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

/** 当前会话里所有「在问、尚未回答」的卡（按出现顺序，askId 去重）。 */
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
      handle: payload.handle ?? payload.taskHandle ?? '',
      subjectKind: payload.subject?.kind ?? 'task',
      subjectId: payload.subject?.id ?? payload.taskId ?? null,
      decision: payload.decision ?? '',
      blocking: payload.blocking !== false,
    })
  }
  return out
}

const VISIBLE_ROWS = 3

export function AuthorAskInbox({ messages }: { messages: AgentMessage[] }) {
  const [answeredIds, setAnsweredIds] = useState<Set<string>>(() => new Set())
  const [activeAskId, setActiveAskId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const pending = useMemo(
    () => pendingAuthorAsks(messages).filter((p) => !answeredIds.has(p.askMessageId)),
    [messages, answeredIds],
  )

  // 焦点自动跟随：当前卡答掉 / 消失后落到下一条，不需要回左栏重新点。
  useEffect(() => {
    if (pending.length === 0) {
      if (activeAskId !== null) setActiveAskId(null)
      return
    }
    if (!activeAskId || !pending.some((p) => p.askMessageId === activeAskId)) {
      setActiveAskId(pending[0].askMessageId)
    }
  }, [pending, activeAskId])

  const active = pending.find((p) => p.askMessageId === activeAskId) ?? null

  const jump = useCallback((id: string) => {
    setActiveAskId(id)
    window.dispatchEvent(new CustomEvent('octopus:open-ask', { detail: { askMessageId: id } }))
  }, [])

  useEffect(() => {
    const onAnswered = (event: Event) => {
      const detail = (event as CustomEvent<{ askMessageId?: string; choice?: string }>).detail
      if (!detail?.askMessageId) return
      setAnsweredIds((prev) => {
        const next = new Set(prev)
        next.add(detail.askMessageId!)
        return next
      })
      // 焦点落到下一条（pending 会在下一次渲染里更新，这里只清掉当前）。
      setActiveAskId((current) => current === detail.askMessageId ? null : current)
    }
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ askMessageId?: string }>).detail?.askMessageId
      if (!id) return
      setActiveAskId(id)
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

  // 键盘：1..9 选选项、↵ 提交。只在没有输入焦点时生效（输入框里的数字照常输入）。
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target as HTMLElement | null)?.isContentEditable) return
      const isOption = /^[1-9]$/.test(event.key)
      if (!isOption && event.key !== 'Enter') return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('octopus:ask-key', {
        detail: { askId: active.askMessageId, key: event.key },
      }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  if (pending.length === 0) return null

  const visible = showAll ? pending : pending.slice(0, VISIBLE_ROWS)
  const hidden = pending.length - visible.length

  return (
    <div data-testid="author-ask-inbox" className="sticky top-0 z-20 mb-2 flex flex-col gap-1">
      <div className="rounded-lg border-2 border-pop-amber/60 bg-pop-amber-soft/95 px-2.5 py-1.5 shadow-pop backdrop-blur">
        <div className="flex items-center gap-2 text-[11px] font-bold text-pop-amber">
          <MessageSquare className="size-3" aria-hidden />
          {pending.length} 个作业在等你 · 一次处理一条
          <span className="flex-1" />
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="shrink-0 rounded-full border border-pop-amber/40 px-1.5 py-0.5 text-[10px] font-bold text-pop-amber hover:bg-pop-amber/10"
            >
              +{hidden} 条待处理
            </button>
          )}
          {showAll && pending.length > VISIBLE_ROWS && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="shrink-0 text-[10px] font-bold text-pop-dim hover:text-pop-ink"
            >
              收起
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {visible.map((item) => {
            const isActive = item.askMessageId === activeAskId
            return (
              <button
                key={item.askMessageId}
                type="button"
                data-testid="author-ask-inbox-row"
                data-active={isActive ? 'true' : undefined}
                onClick={() => jump(item.askMessageId)}
                className={`flex items-center gap-2 rounded px-1 py-0.5 text-left text-[11.5px] transition-colors ${
                  isActive ? 'bg-pop-amber/20' : 'hover:bg-white/10'
                }`}
              >
                <span className="w-7 shrink-0 font-mono text-[10.5px] font-bold text-pop-amber">
                  {item.handle || '—'}
                </span>
                <span className="max-w-[30%] truncate font-semibold text-pop-ink">{item.taskName}</span>
                <span className="min-w-0 flex-1 truncate text-pop-dim">
                  {item.decision || item.question || '（打开卡片看问题）'}
                </span>
                {!item.blocking && <span className="shrink-0 text-[9.5px] text-pop-dim">不阻塞</span>}
                <span className="shrink-0 text-[10px] font-bold text-pop-cyan">
                  {isActive ? '回答中' : '回答 →'}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {active && (
        <div
          data-testid="decision-focus-bar"
          className="flex items-center gap-2 rounded-lg border border-pop-cyan/50 bg-pop-cyan/10 px-2.5 py-1 text-[11px] text-pop-cyan backdrop-blur"
        >
          <span className="font-mono font-bold">{active.handle || '—'}</span>
          <span className="min-w-0 flex-1 truncate">
            正在回答 {active.taskName}
            {active.decision ? ` · ${active.decision}` : active.question ? ` · ${active.question}` : ''}
          </span>
          <span className="hidden shrink-0 text-[10px] text-pop-dim sm:inline">1/2/3 选项 · ↵ 提交</span>
          <button
            type="button"
            aria-label="取消焦点"
            title="取消焦点"
            onClick={() => setActiveAskId(null)}
            className="shrink-0 rounded p-0.5 text-pop-dim hover:text-pop-ink"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
