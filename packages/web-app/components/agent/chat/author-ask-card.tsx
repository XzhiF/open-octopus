'use client'

// 作者提问卡（design 23 §2 就地作答 + design 24 信封 + design 25 §5.6 交互转移）
//
// 任务作者 / 委派 doer 在会话里 AskUserQuestion 时，server 把同一组问题追加成
// 一张 displayType:'event' 的卡片到**舱主对话**（activity.payload.authorAsk）。
// 用户不用切对话，就在汐音这条 chat 里把问题答完。
//
// 2026-11-16（design 25）三条关键变化：
//   · 提交走 `POST /api/cabins/:id/decisions`：**票据 askId 来自卡片自身 payload**，
//     不取 UI 焦点 —— 快速连答也不会把 A 的答案送给 B；
//   · 提交成功**立刻**置灰 + 回执，不等汐音转达（§5.6 第 5 步）；
//   · 卡片带信封上下文（决策 / 原文 / 选项影响 / 作者建议 / 出处），人能盲答。
//
// 旧服务端（没有 decisions 端点）自动退回「直接转发作者线程」的兼容路径。

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, MessageSquare } from 'lucide-react'
import type { AgentMessage } from '@/lib/agent/types'
import type { ChatMessage } from '@/lib/types'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { AskUserQuestionCard } from '@/components/workspace/chat/ask-user-question-card'
import { openTaskInChat } from '@/components/cabin/modules/ui'
import { useAskSubmit } from '@/components/cabin/asks/ask-submit'
import { discussCabinAsk } from '@/lib/cabin-api'

interface AuthorAskOption {
  label?: string
  impact?: string
}

interface AuthorAskPayload {
  authorAsk?: boolean
  authorSessionId?: string
  askMessageId?: string
  cabinId?: string
  taskId?: string
  taskName?: string
  subject?: { kind: 'task' | 'delegation'; id: string }
  handle?: string
  taskHandle?: string
  decision?: string
  recommendation?: { label?: string; reason?: string }
  options?: AuthorAskOption[]
  blocking?: boolean
  intent?: string
  phase?: { index?: number; round?: number } | null
  origin?: string
  questions?: unknown
}

/** 提交管线与解析在 asks/ask-submit（与问答窗共用）；这里保留同名导出。 */
export { parseAnsweredChoice } from '@/components/cabin/asks/ask-submit'

function envelopeState(payload: AuthorAskPayload) {
  const phase = payload.phase && typeof payload.phase.index === 'number'
    ? `P${payload.phase.index}${payload.phase.round ? ` · R${payload.phase.round}` : ''}`
    : null
  const options = (payload.options ?? []).filter((o) => typeof o?.label === 'string' && o.label)
  return { phase, options }
}

export function AuthorAskCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const payload = (activity?.payload ?? {}) as AuthorAskPayload
  const cabin = useCabinOptional()
  const cabinId = cabin?.cabinId ?? null
  const [answered, setAnswered] = useState(!!activity?.decision)
  const [receipt, setReceipt] = useState<string | null>(() => {
    const label = activity?.decision?.label
    if (typeof label !== 'string' || !label) return null
    // 旧数据 / 线程兜底：保持「已回答 · 作者继续推进」的人话说法。
    if (label === '已回答') return `已回答 · ${payload.taskName ?? '任务'}的作者继续推进`
    const handlePrefix = payload.handle ?? payload.taskHandle
    return `✓ 已答 · ${handlePrefix ? `${handlePrefix} ` : ''}${payload.taskName ?? '任务'}：${label}`
  })

  const effectiveCabinId = payload.cabinId ?? cabinId ?? null
  const askId = payload.askMessageId ?? message.id
  const handle = payload.handle ?? payload.taskHandle ?? ''
  const taskName = payload.taskName ?? '任务'
  const anchorId = `author-ask-${askId}`
  const { phase, options } = envelopeState(payload)

  // v22 #9（2026-11-23 用户）：输入框上方的「待你定」浮条退役 —— 原来由它接的
  // `octopus:open-ask`（滚到这张卡）改由卡片自己接住。
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ askMessageId?: string }>).detail?.askMessageId
      if (!id || id !== askId) return
      const el = document.getElementById(anchorId)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-pop-amber')
      window.setTimeout(() => el.classList.remove('ring-2', 'ring-pop-amber'), 1_800)
    }
    window.addEventListener('octopus:open-ask', onOpen)
    return () => window.removeEventListener('octopus:open-ask', onOpen)
  }, [askId, anchorId])

  // 与问答窗共用同一套提交语义（design 26 §5.1）：票据、幂等、回执、事件。
  const { submit, busy, failed } = useAskSubmit({
    cabinId: effectiveCabinId,
    askId,
    ...(typeof payload.authorSessionId === 'string' ? { authorSessionId: payload.authorSessionId } : {}),
    ...(handle ? { handle } : {}),
    taskName,
    ...(payload.subject?.kind === 'task' ? { taskId: payload.subject.id } : {}),
    optionLabels: options.map((o) => o.label ?? '').filter(Boolean),
    messageId: message.id,
    threadFallback: true,
  })

  const answer = useCallback(async (content: string) => {
    const outcome = await submit(content)
    if (!outcome.ok) return
    // §5.6 第 5 步：先变只读，再等转达。转达慢 / 失败都不再让卡片回弹。
    setAnswered(true)
    if (outcome.receipt) setReceipt(outcome.receipt)
  }, [submit])

  // 「还需讨论」（用户 #20）：不作答，请作者先把选项讲清楚；提问仍待答。
  const [discussBusy, setDiscussBusy] = useState(false)
  const [discussNote, setDiscussNote] = useState<string | null>(null)
  const chatAbout = useCallback(async (summary?: string) => {
    if (!effectiveCabinId || discussBusy || busy) return
    setDiscussBusy(true)
    setDiscussNote(null)
    try {
      const res = await discussCabinAsk(effectiveCabinId, {
        askId,
        ...(summary ? { note: summary } : {}),
      })
      setDiscussNote(res.receipt)
    } catch (err) {
      setDiscussNote(err instanceof Error ? err.message : '讨论请求没有发出去')
    } finally {
      setDiscussBusy(false)
    }
  }, [askId, busy, discussBusy, effectiveCabinId])

  if (answered) {
    return (
      <div
        id={anchorId}
        data-author-task={payload.taskId ?? undefined}
        data-testid="author-ask-card"
        data-answered="true"
        className="mb-4 max-w-[90%] rounded-[14px] border-[2.5px] border-pop-bd bg-pop-green-soft px-4 py-3 text-sm text-pop-ink shadow-pop"
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0 text-pop-green" />
          <span>{receipt ?? `已回答 · ${taskName}的作者继续推进`}</span>
        </div>
      </div>
    )
  }

  // 没有作者线程 / 问题体（旧数据）：给一条可点的退路，而不是一张死卡。
  const questions = payload.questions
  if (!payload.authorSessionId || !questions) {
    return (
      <div
        id={anchorId}
        data-author-task={payload.taskId ?? undefined}
        data-testid="author-ask-card"
        className="mb-4 max-w-[90%] rounded-[14px] border-[2.5px] border-pop-bd bg-pop-paper px-4 py-3 text-sm text-pop-ink shadow-pop"
      >
        <div className="mb-2 flex items-center gap-2 text-[11px] text-pop-dim">
          <MessageSquare className="size-3" />
          {taskName}的作者在问你
        </div>
        <div className="text-pop-ink/80">这张提问卡缺少转发信息，请去任务线程回答。</div>
        {payload.taskId && (
          <button
            type="button"
            className="mt-2 text-[11.5px] font-bold text-pop-cyan hover:underline"
            onClick={() => openTaskInChat(payload.taskId as string)}
          >
            任务线程 · 去回答 →
          </button>
        )}
      </div>
    )
  }

  const synthetic: ChatMessage = {
    id: message.id,
    sessionId: message.session_id,
    role: 'assistant',
    displayType: 'ask_user_question',
    content: '',
    timestamp: message.created_at,
    toolCallId: `author-ask-${message.id}`,
    toolName: 'AskUserQuestion',
    toolInput: questions,
    toolStatus: 'done',
  }

  const hasEnvelope = !!(payload.decision || payload.intent || options.length
    || payload.recommendation?.label)

  return (
    <div
      id={anchorId}
      data-author-task={payload.taskId ?? undefined}
      data-testid="author-ask-card"
      data-handle={handle || undefined}
      className="mb-2 rounded-[14px] border-[2px] border-pop-amber/50 bg-pop-amber-soft/40 p-2"
    >
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <MessageSquare className="size-3 text-pop-amber" />
        <span className="font-bold text-pop-ink">
          {handle ? <span className="font-mono text-pop-amber">{handle}</span> : null}
          {handle ? ' ' : ''}{taskName}的作者在问你
        </span>
        {phase && <span className="font-mono text-[10px] text-pop-dim">{phase}</span>}
        {payload.blocking === false && <span className="text-[10px] text-pop-dim">不阻塞</span>}
        <span className="flex-1" />
        {payload.taskId && (
          <button
            type="button"
            className="shrink-0 text-[10.5px] font-bold text-pop-cyan hover:underline"
            onClick={() => openTaskInChat(payload.taskId as string)}
          >
            任务线程 · 看过程 →
          </button>
        )}
      </div>

      {hasEnvelope && (
        <details
          open
          data-testid="author-ask-envelope"
          className="mb-1.5 rounded-lg border border-pop-bd/60 bg-pop-paper/70 px-2 py-1.5 text-[11.5px] text-pop-ink"
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-pop-dim">
            <ChevronDown className="size-3" />
            {payload.decision ? (
              <span className="min-w-0 truncate">
                <span className="font-semibold text-pop-ink">要定的事：</span>{payload.decision}
              </span>
            ) : <span>决策上下文</span>}
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {payload.intent && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-pop-dim/70">你的原始要求</div>
                <div className="whitespace-pre-wrap text-pop-ink/80">{payload.intent}</div>
              </div>
            )}
            {options.some((o) => o.impact) && (
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-pop-dim/70">选项影响</div>
                {options.map((o, i) => (
                  <div key={`${o.label}-${i}`} className="flex gap-1.5">
                    <span className="shrink-0 font-mono text-pop-cyan">{o.label}</span>
                    {o.impact && <span className="text-pop-ink/75">— {o.impact}</span>}
                  </div>
                ))}
              </div>
            )}
            {payload.recommendation?.label && (
              <div className="text-pop-amber">
                <span className="font-bold">作者建议：</span>{payload.recommendation.label}
                {payload.recommendation.reason ? ` · ${payload.recommendation.reason}` : ''}
              </div>
            )}
          </div>
        </details>
      )}

      <AskUserQuestionCard
        message={synthetic}
        onAnswer={answer}
        onChatAbout={(summary) => void chatAbout(summary)}
        disabled={busy || discussBusy}
        hideChatAbout
        hotkeyId={askId}
      />
      {discussNote && (
        <div data-testid="author-ask-discuss-note" className="mt-1 text-[11px] text-pop-cyan">
          {discussNote}
        </div>
      )}
      {failed && (
        <div data-testid="author-ask-failed" className="mt-1 text-[11px] text-pop-red">
          {failed}
        </div>
      )}
    </div>
  )
}
