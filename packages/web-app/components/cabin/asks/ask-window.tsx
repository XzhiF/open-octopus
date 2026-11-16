'use client'

// 单扇问答窗（design 26 §3.2 / §3.5）。
//
// chrome：关闭灯组在左（✕ 是标题栏第一个可点元素）；标题 = handle + 作业名 +
// 状态胶囊 + 右侧上下文；底部只有一个「关闭」，不放「去作业面看过程」。
// 内容：信封（要定的事 / 原始要求 / 选项影响 / 作者建议）+ AskUserQuestionCard。
// 作答：复用 useAskSubmit（与主 chat 那张卡同一票据、同一账本），成功后原地
// 变回执、窗不自动关。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, MessageSquare, X } from 'lucide-react'
import type { ChatMessage } from '@/lib/types'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { dismissCabinAsk } from '@/lib/cabin-api'
import { AskUserQuestionCard } from '@/components/workspace/chat/ask-user-question-card'
import { openTaskInChat } from '@/components/cabin/modules/ui'
import { useAskWindows, type AskWindowEntry } from './ask-windows-provider'
import { useAskSubmit } from './ask-submit'
import { askWindowContext, askWindowTitle } from './ask-window-model'

export interface AskWindowProps {
  entry: AskWindowEntry
  left: number
  top: number
  width: number
  className?: string
  onMove: (left: number, top: number) => void
  onFocus: () => void
  onClose: () => void
}

interface QuestionOption { label?: string; description?: string }

function questionOptions(questions: unknown): QuestionOption[] {
  const list = (questions as { questions?: unknown })?.questions
  if (!Array.isArray(list)) return []
  const first = list[0] as { options?: unknown } | undefined
  return Array.isArray(first?.options) ? first.options as QuestionOption[] : []
}

function answerContent(decision: string, value: string): string {
  return `用户回答了以下问题：\n\n1. [要定的事] ${decision || '选择'}\n   → ${value}`
}

export function AskWindow({ entry, left, top, width, className, onMove, onFocus, onClose }: AskWindowProps) {
  const cabin = useCabinOptional()
  const { markAnswered } = useAskWindows()
  const { item, env, answered: answeredFlag, external } = entry

  const [receipt, setReceipt] = useState<string | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [needsThread, setNeedsThread] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [dismissErr, setDismissErr] = useState<string | null>(null)

  const options = useMemo(() => env.options ?? [], [env.options])
  const optionLabels = useMemo(() => {
    const fromEnv = options.map((o) => o.label).filter(Boolean)
    if (fromEnv.length > 0) return fromEnv
    return questionOptions(env.questions).map((o) => o.label ?? '').filter(Boolean)
  }, [env.questions, options])

  const { submit, busy, failed } = useAskSubmit({
    cabinId: cabin?.cabinId ?? null,
    askId: entry.askId,
    ...(env.author_session_id ? { authorSessionId: env.author_session_id } : {}),
    ...(item.handle ? { handle: item.handle } : {}),
    ...(item.subject?.kind === 'task' ? { taskId: item.subject.id } : {}),
    optionLabels,
    ...(env.message_id ? { messageId: env.message_id } : {}),
    // 问答窗不偷偷转发：旧服务端只提示「去任务线程回答」。
    threadFallback: false,
  })

  const answered = answeredFlag || external

  const handleAnswer = useCallback(async (content: string) => {
    setNeedsThread(false)
    const outcome = await submit(content)
    if (outcome.ok) {
      markAnswered(entry.askId)
      setReceipt(outcome.receipt ?? `✓ 已答 · ${outcome.choice ?? ''} —— 已从编队消项，窗口可手动关闭`)
    } else if (outcome.needsThread) {
      setNeedsThread(true)
    }
  }, [entry.askId, markAnswered, submit])

  // 忽略旧卡 / 不再需要回答的那条：只改消息 decision，不转达、不写账本。
  const handleDismiss = useCallback(async () => {
    setDismissErr(null)
    if (!cabin?.cabinId) {
      setDismissErr('没有舱上下文，无法忽略这条')
      return
    }
    setDismissing(true)
    try {
      const res = await dismissCabinAsk(cabin.cabinId, entry.askId)
      if (res.dismissed > 0) {
        markAnswered(entry.askId)
        onClose()
        return
      }
      setDismissErr('这条提问没有可忽略的会话消息（工作流提问请在工作流侧处理）')
    } catch (err) {
      setDismissErr(err instanceof Error ? err.message : '忽略失败')
    } finally {
      setDismissing(false)
    }
  }, [cabin?.cabinId, entry.askId, markAnswered, onClose])

  // 重复点同一行：闪一下边框（不新建窗）。
  const flashRef = useRef(entry.flash)
  useEffect(() => {
    if (entry.flash === flashRef.current) return
    flashRef.current = entry.flash
    setFlashing(true)
    const timer = window.setTimeout(() => setFlashing(false), 700)
    return () => window.clearTimeout(timer)
  }, [entry.flash])

  // ── 拖动（标题栏；不缩放）────────────────────────────────────────────
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const positionRef = useRef({ left, top })
  positionRef.current = { left, top }

  const beginDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: positionRef.current.left,
      top: positionRef.current.top,
    }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    onMove(drag.left + (event.clientX - drag.x), drag.top + (event.clientY - drag.y))
  }, [onMove])

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }, [])

  const synthetic: ChatMessage | null = useMemo(() => {
    if (!env.questions) return null
    return {
      id: `ask-window-${entry.askId}`,
      sessionId: env.author_session_id ?? '',
      role: 'assistant',
      displayType: 'ask_user_question',
      content: '',
      timestamp: '',
      toolCallId: `ask-window-${entry.askId}`,
      toolName: 'AskUserQuestion',
      toolInput: env.questions,
      toolStatus: 'done',
    }
  }, [entry.askId, env.author_session_id, env.questions])

  const decision = env.decision ?? item.question ?? ''
  const ctx = askWindowContext(item, env)
  const hasEnvelope = !!(env.intent || options.some((o) => o.impact) || env.recommendation?.label)

  const answerByFallback = () => {
    const value = choice ?? text.trim()
    if (!value) return
    void handleAnswer(answerContent(decision, value))
  }

  // 打开时焦点进窗；关闭由 Provider 把焦点还给触发行的按钮。
  const rootRef = useRef<HTMLElement | null>(null)
  useEffect(() => { rootRef.current?.focus() }, [])

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className={`ck-askwin${flashing ? ' is-flash' : ''}${className ? ` ${className}` : ''}`}
      style={{ left, top, width, zIndex: entry.z }}
      data-ask={entry.askId}
      data-testid={`ask-window-${entry.askId}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`askwin-title-${entry.askId}`}
      onPointerDownCapture={onFocus}
      onKeyDown={(event) => {
        // 1/2/3 选选项、↵ 提交：复用 AskUserQuestionCard 的 hotkey 通道。
        // 输入框 / 按钮上的键让原生行为走，不抢。
        if (answered) return
        const key = event.key
        if (key !== 'Enter' && !/^[1-9]$/.test(key)) return
        const target = event.target
        if (target instanceof HTMLElement && target.closest('input, textarea, button, [contenteditable="true"]')) return
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('octopus:ask-key', {
          detail: { askId: entry.askId, key },
        }))
      }}
    >
      <header
        className="ck-askwin-h"
        onPointerDown={beginDrag}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="ck-askwin-lights">
          <button
            type="button"
            className="ck-askwin-x"
            aria-label="关闭问答窗"
            title="关闭（Esc）"
            data-ask-close
            onClick={onClose}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
        <span className="ck-askwin-glyph" aria-hidden="true">✧</span>
        <span className="ck-askwin-tag">Q</span>
        <span className="ck-askwin-title" id={`askwin-title-${entry.askId}`}>
          {item.handle && <b className="ck-askwin-handle">{item.handle}</b>}
          {askWindowTitle(item)}
        </span>
        <span className="ck-askwin-pill" data-state={answered ? 'done' : 'wait'}>
          {answered ? '已答' : '等你定'}
        </span>
        {ctx && <span className="ck-askwin-ctx">{ctx}</span>}
        <span className="ck-askwin-grip" aria-hidden="true">⠿</span>
      </header>

      <div className="ck-askwin-body">
        <div className="ck-askwin-from">
          <span className="ck-askwin-av" aria-hidden="true">汐</span>
          <span>
            <b>汐音</b> · {askWindowTitle(item)} 在等你定一件事
          </span>
        </div>

        {!answered && hasEnvelope && (
          <details className="ck-askwin-env" open>
            <summary>
              <ChevronDown className="size-3" aria-hidden="true" />
              {decision
                ? <span className="ck-askwin-env-tx"><b>要定的事：</b>{decision}</span>
                : <span>决策上下文</span>}
            </summary>
            <div className="ck-askwin-env-body">
              {env.intent && (
                <div>
                  <div className="ck-askwin-k">你的原始要求</div>
                  <div className="ck-askwin-v">{env.intent}</div>
                </div>
              )}
              {options.some((o) => o.impact) && (
                <div>
                  <div className="ck-askwin-k">选项影响</div>
                  {options.map((o, i) => (
                    <div key={`${o.label}-${i}`} className="ck-askwin-optline">
                      <span className="ck-askwin-optlabel">{o.label}</span>
                      {o.impact && <span>— {o.impact}</span>}
                    </div>
                  ))}
                </div>
              )}
              {env.recommendation?.label && (
                <div className="ck-askwin-rec">
                  <b>作者建议：</b>{env.recommendation.label}
                  {env.recommendation.reason ? ` · ${env.recommendation.reason}` : ''}
                </div>
              )}
            </div>
          </details>
        )}

        {answered ? (
          <div className="ck-askwin-receipt" data-testid="ask-window-receipt">
            <CheckCircle2 className="size-4 shrink-0 text-pop-green" aria-hidden="true" />
            <span>
              {receipt ?? (external
                ? '已在别处答过 —— 窗可手动关闭'
                : '✓ 已答 —— 已从编队消项，窗口可手动关闭')}
            </span>
          </div>
        ) : synthetic ? (
          <div className="ck-askwin-qa">
            <AskUserQuestionCard
              message={synthetic}
              onAnswer={(content) => void handleAnswer(content)}
              disabled={busy}
              hideChatAbout
              hotkeyId={entry.askId}
            />
          </div>
        ) : (
          // 没有原问题体（旧数据 / 只有信封）：用信封选项 + 自由文本作答。
          <div className="ck-askwin-fallback" data-testid="ask-window-fallback">
            <div className="ck-askwin-q">{decision || '汐音在等你定一件事'}</div>
            {options.length > 0 && (
              <div className="ck-askwin-opts" role="radiogroup" aria-label="选项">
                {options.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={choice === o.label}
                    className="ck-askwin-opt"
                    data-on={choice === o.label ? 'true' : undefined}
                    onClick={() => setChoice(o.label)}
                  >
                    <span className="ck-askwin-radio" aria-hidden="true" />
                    <span className="ck-askwin-optmain">
                      <span>{o.label}</span>
                      {(o.impact || o.description) && (
                        <span className="ck-askwin-optimpact">· {o.impact ?? o.description}</span>
                      )}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="ck-askwin-other"
                  data-on={choice === null ? 'true' : undefined}
                  onClick={() => setChoice(null)}
                >
                  <span className="ck-askwin-radio" aria-hidden="true" />
                  其他 / 补充
                </button>
              </div>
            )}
            <textarea
              className="ck-askwin-text"
              placeholder={options.length > 0 ? '也可以直接写你的回答…' : '写下你的回答…'}
              value={text}
              rows={2}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="ck-askwin-sendrow">
              <button
                type="button"
                className="ck-askwin-send"
                disabled={busy || !(choice ?? text.trim())}
                onClick={answerByFallback}
              >
                发送答案
              </button>
            </div>
          </div>
        )}

        {(failed || needsThread || dismissErr) && (
          <div className="ck-askwin-err" data-testid="ask-window-error">
            <span>{dismissErr ?? failed ?? '这个提问需要去任务线程回答'}</span>
            {needsThread && item.task_id && (
              <button
                type="button"
                className="ck-askwin-link"
                onClick={() => openTaskInChat(item.task_id as string)}
              >
                去任务线程回答 →
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="ck-askwin-foot">
        <span className="ck-askwin-sig">
          <MessageSquare className="size-3" aria-hidden="true" />
          答完汐音会转达，窗口不会自动关
        </span>
        {!answered && (
          <button
            type="button"
            className="ck-askwin-dismiss"
            data-testid="ask-window-dismiss"
            disabled={dismissing}
            title="不再等这条回答（不转达，只从待办里去掉）"
            onClick={() => void handleDismiss()}
          >
            {dismissing ? '忽略中…' : '忽略这条'}
          </button>
        )}
        <button type="button" className="ck-askwin-close" onClick={onClose}>关闭</button>
      </footer>
    </section>
  )
}
