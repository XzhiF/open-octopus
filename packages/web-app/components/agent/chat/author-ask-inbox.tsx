'use client'

// 决策队列（design 23 §2 续 → design 25 §5.3 / §5.6）
//
// 编队里多条 attention 同时来是常态。这里在转录顶端给一条合并 dock：
//   · 常驻行 = 计数「待你定 N」+ 当前一条（handle / 作业 / 要定的事）；
//   · 2 条以上在下面挂列表，同屏最多 3 条，其余折成「+N 条待处理」；
//   · 键盘 1/2/3 选当前卡的选项、↵ 提交；提交后焦点自动下一条；
//   · 焦点行常驻，切任务变成一次显式操作而不是滚动。
//
// 2026-11-16 改版：原「琥珀队列条 + 青色焦点条」两条堆叠重复且缝隙漏字，
// 改为一块实面板（左琥珀脊线 + 激活行内高亮），见 tmp/inbox-redesign.html 方案 A。
// 归属永远由卡片 payload 里的 askId 决定（票据），焦点只是 UI 提示。

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [expanded, setExpanded] = useState(false)
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
  const multi = pending.length > 1
  // 常驻行永远有可显示的一条（effect 会在下一拍把 activeAskId 落到首条）。
  const focusItem = active ?? pending[0]
  // 多条才展开列表；答到只剩一条时自动收起，不留一块空面板。
  const listOpen = expanded && multi

  return (
    <div
      data-testid="author-ask-inbox"
      className="relative -mb-px rounded-t-[9px] border border-b-0 border-pop-bd bg-pop-paper/95 px-2.5 pb-1.5 pt-1"
    >
      {/* 多条：列表向上展开（贴 composer 上沿，不挡阅读区）。 */}
      {listOpen && (
        <div className="mb-1 flex flex-col gap-0.5 border-b border-pop-bd/60 pb-1">
          {visible.map((item) => {
            const isActive = item.askMessageId === activeAskId
            return (
              <button
                key={item.askMessageId}
                type="button"
                data-testid="author-ask-inbox-row"
                data-active={isActive ? 'true' : undefined}
                onClick={() => jump(item.askMessageId)}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] transition-colors ${
                  isActive
                    ? 'bg-pop-amber/15 shadow-[inset_2px_0_0_var(--pop-amber)]'
                    : 'hover:bg-white/5'
                }`}
              >
                <span className="w-6 shrink-0 font-mono text-[10px] font-bold text-pop-amber">
                  {item.handle || '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-pop-dim">
                  {item.decision || item.question || '（打开卡片看问题）'}
                </span>
                {!item.blocking && <span className="shrink-0 text-[9.5px] text-pop-dim">不阻塞</span>}
                <span
                  className={`shrink-0 text-[9.5px] font-bold ${
                    isActive ? 'text-pop-cyan' : 'text-pop-dim'
                  }`}
                >
                  {isActive ? '◉ 回答中' : '回答 →'}
                </span>
              </button>
            )
          })}
          {hidden > 0 && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="self-start rounded-full border border-pop-amber/30 px-1.5 py-0.5 text-[10px] font-bold text-pop-amber hover:bg-pop-amber/10"
            >
              +{hidden} 条待处理
            </button>
          )}
          {showAll && pending.length > VISIBLE_ROWS && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="self-start text-[10px] font-bold text-pop-dim hover:text-pop-ink"
            >
              收起
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px]">
        <i className="size-1.5 shrink-0 rounded-full bg-pop-amber" aria-hidden="true" />
        <b className="shrink-0 font-mono text-[10px] font-bold text-pop-amber">
          待你定 {pending.length}
        </b>
        <button
          type="button"
          data-testid="author-ask-inbox-now"
          onClick={() => jump(focusItem.askMessageId)}
          title="跳到这张卡"
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-0.5 py-0.5 text-left text-[11.5px] transition-colors hover:bg-white/5"
        >
          <span className="shrink-0 font-mono text-[10px] font-bold text-pop-amber">
            {focusItem.handle || '—'}
          </span>
          <span className="max-w-[32%] shrink-0 truncate font-semibold text-pop-ink">
            {focusItem.taskName}
          </span>
          <span className="min-w-0 flex-1 truncate text-pop-dim">
            {focusItem.decision || focusItem.question || '（打开卡片看问题）'}
          </span>
          <span className="hidden shrink-0 font-mono text-[9.5px] font-semibold text-pop-dim/70 sm:inline">
            1/2/3 · ↵
          </span>
          <span className="shrink-0 text-[10px] font-bold text-pop-cyan">回答 →</span>
        </button>
        {multi && (
          <button
            type="button"
            data-testid="author-ask-inbox-expand"
            aria-expanded={listOpen}
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded-full border border-pop-amber/30 px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-pop-amber hover:bg-pop-amber/10"
          >
            {listOpen ? '收起 ⌄' : `${pending.length} 条 ⌃`}
          </button>
        )}
      </div>
    </div>
  )
}
