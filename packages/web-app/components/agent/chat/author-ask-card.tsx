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

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, MessageSquare } from 'lucide-react'
import type { AgentMessage } from '@/lib/agent/types'
import type { ChatMessage } from '@/lib/types'
import { chatStream, recordCardDecision } from '@/lib/agent/api'
import { submitCabinDecision, CabinDecisionError } from '@/lib/cabin-api'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { AskUserQuestionCard } from '@/components/workspace/chat/ask-user-question-card'
import { openTaskInChat } from '@/components/cabin/modules/ui'

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

const RETRY_DELAYS = [2_000, 5_000]

/** 送进作者线程一轮；只等「已被受理」的信号（首块或被拒），不等整轮跑完。 */
function forwardOnce(authorSessionId: string, content: string): Promise<void> {
  const conn = chatStream(authorSessionId, content)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void (async () => {
        try {
          for (;;) { const { done } = await conn.reader.read(); if (done) break }
        } catch { /* 受理后的读失败不影响送达 */ }
      })()
      resolve()
    }, 4_000)
    conn.reader.read().then(({ done }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void (async () => {
        try {
          if (done) return
          for (;;) { const { done: d } = await conn.reader.read(); if (d) break }
        } catch { /* 同上 */ }
      })()
      resolve()
    }).catch((err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function forwardWithRetry(authorSessionId: string, content: string): Promise<void> {
  let last: unknown = null
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      await forwardOnce(authorSessionId, content)
      return
    } catch (err) {
      last = err
      const delay = RETRY_DELAYS[attempt]
      if (delay == null) break
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw last instanceof Error ? last : new Error('回答发送失败')
}

/** 从「用户回答了以下问题」正文里取第一个 → 后的选择（逐字）与其余补充。 */
export function parseAnsweredChoice(content: string): { choice: string; note?: string } {
  const lines = content.split('\n')
  const arrows = lines
    .map((line) => /^\s*→\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((v): v is string => !!v)
  const choice = arrows[0] ?? content.trim()
  const note = arrows.length > 1 ? arrows.slice(1).join('；') : undefined
  return { choice, ...(note ? { note } : {}) }
}

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
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
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

  const answer = useCallback(async (content: string) => {
    const authorSessionId = payload.authorSessionId
    if (!authorSessionId) {
      toast.error('缺少作者线程，暂时无法就地回答')
      return
    }
    setBusy(true)
    setFailed(null)
    const { choice, note } = parseAnsweredChoice(content)
    // Other / 自由文本不是选项选择：走 composer 语义（服务端放宽逐字命中）。
    const isOption = options.some((o) => o.label === choice)
    try {
      if (effectiveCabinId) {
        try {
          const res = await submitCabinDecision(effectiveCabinId, {
            askId,
            choice,
            ...(note ? { note } : {}),
            source: isOption ? 'card' : 'composer',
            focusAtSubmit: askId,
            ...(payload.subject?.kind === 'task' ? { taskId: payload.subject.id } : {}),
          })
          // §5.6 第 5 步：先变只读，再等转达。转达慢 / 失败都不再让卡片回弹。
          setAnswered(true)
          setReceipt(res.receipt.line)
          toast.success(res.already ? res.receipt.line : '已记下，汐音正在转达')
          window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
            detail: { askMessageId: askId, handle, choice },
          }))
          return
        } catch (err) {
          // 服务端明确拒绝（归属 / 选项 / 已过期）：不要把答案偷偷发到别处。
          if (err instanceof CabinDecisionError && err.status !== 404 && err.status !== 503) {
            if (err.status === 409 && /已经答过|已答/.test(err.message)) {
              setAnswered(true)
              setReceipt(`已经答过（${err.message}）`)
              window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
                detail: { askMessageId: askId },
              }))
              return
            }
            setFailed(err.message)
            toast.error(err.message)
            return
          }
          // 旧服务端 / 网络不可达：落到兼容的直发路径。
        }
      }
      await forwardWithRetry(authorSessionId, content)
      void recordCardDecision(message.id, { actionId: 'answer_author_ask', label: '已回答' })
        .catch(() => {})
      setAnswered(true)
      setReceipt(`✓ 已答 · ${handle ? `${handle} ` : ''}${taskName}：${choice}（已直接转达）`)
      window.dispatchEvent(new CustomEvent('octopus:author-ask-answered', {
        detail: { askMessageId: askId, handle, choice },
      }))
      toast.success('已回答 · 任务作者继续推进')
    } catch {
      setFailed('作者线程正忙，答案没有送达 —— 请再点一次提交')
      toast.error('作者线程正忙，答案没有送达 —— 请再点一次提交')
    } finally {
      setBusy(false)
    }
  }, [askId, effectiveCabinId, handle, message.id, options, payload.authorSessionId, payload.subject, taskName])

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
            去任务对话 →
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
            去任务对话 →
          </button>
        )}
      </div>

      {hasEnvelope && (
        <details
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

      <AskUserQuestionCard message={synthetic} onAnswer={answer} disabled={busy} hideChatAbout hotkeyId={askId} />
      {failed && (
        <div data-testid="author-ask-failed" className="mt-1 text-[11px] text-pop-red">
          {failed}
        </div>
      )}
    </div>
  )
}
