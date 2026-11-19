'use client'

// v21（design 31 §3.2.2）· 「要我处理」浮层：列表在右、回复卡在左。
//
// 就地回：点一条 → 左侧开回复卡（两栏）→ 选项 / 自由输入 → 走 useAskSubmit
// 真决策管线 → 回执 1.4s → 回列表；全清后 0.7s 自动收起。
// **不跳作战线程** —— 这是 v21 与 v20 决断面板的关键区别（面板仍作为「全部决断」）。
// 没有决策信封的行不假造选项，只给「去处理 ▦」（打开作业面 / attention 面）。
//
// v21 七轮（用户：「一步一步展开」）：待放行也不再弹独立放行窗 —— 和问答一样
// 在浮层左栏就地展开（选项 + 确认执行 + 回执），关掉再开窗的跳变不符合原型。
// 卡片底部保留「▦ 看任务详情」→ 弹作战详情、落在「对话」页签。
//
// 2026-11-19（用户：全舱点「待你定」只能看详情，classic 却能直接勾选）：
// 任务作者的提问常常只带 AskUserQuestion 原问题体（`ask.questions`，没有扁平
// `ask.options`），旧判定只看 options → 一律落到「去处理」。现在有原问题体就
// 直接渲染 classic 同一张 AskUserQuestionCard（多选 / 其他 / 逐字选项），
// 同时保留「▦ 看任务详情」入口。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatMessage } from '@/lib/types'
import { ackCabinAttention } from '@/lib/cabin-api'
import { AskUserQuestionCard } from '@/components/workspace/chat/ask-user-question-card'
import { useAskSubmit } from '@/components/cabin/asks/ask-submit'
import {
  START_SUMMARY,
  startDecisionKey,
  startErrorText,
  startKindOf,
  startOptionsOf,
  type StartChoice,
} from '@/components/cabin/asks/start-window'
import { readyTask, resumeTask, triggerTask } from '@/lib/tasks-api'
import { useCockpitState } from '../state/CockpitStateProvider'
import { attentionStageLabel } from '../fx/CockpitBrief'
import {
  askQuestionsOf,
  canAnswerInline,
  groupedInbox,
  inboxGroupOf,
  inboxVerb,
  type InboxCounts,
  type InboxEntry,
  type InboxGroup,
} from './inbox-model'

/** 比聊天浮窗（60）/ 编队抽屉（70）/ 问答窗（100）都高：Esc 先收这张浮层。 */
const INBOX_LAYER_PRIORITY = 120
const RECEIPT_MS = 1400
const AUTO_CLOSE_MS = 700

/** 放行回执卡正文（浮层皮肤里不再重复 ✓ 前缀，由卡片统一加）。 */
const START_RECEIPT_TEXT: Record<StartChoice, string> = {
  launch: '已开跑 · 已入列并触发 phase 1',
  enqueue: '已入列 · 等你触发',
  trigger: '已触发执行',
  resume: '已恢复推进',
}

function groupClass(entry: InboxEntry): InboxGroup {
  return inboxGroupOf(entry.item)
}

function jobLine(entry: InboxEntry): string {
  return entry.item.title.replace(/\s*·\s*.*$/, '')
}

interface ReplyCardProps {
  entry: InboxEntry
  onAnswered: (id: string, choice: string) => void
  onDone: () => void
  onDeal: (entry: InboxEntry) => void
  onOpenDetail: (entry: InboxEntry) => void
}

function ReplyCard({ entry, onAnswered, onDone, onDeal, onOpenDetail }: ReplyCardProps) {
  const { closeInbox, selectInbox, entryCabinId } = useCockpitState()
  const { item } = entry
  const env = item.ask
  const options = useMemo(() => env?.options ?? [], [env?.options])
  // AskUserQuestion 原问题体：任务作者的提问多数只带这个（没有扁平 options）。
  // 有它就用 classic 问答窗同一张卡，不再退化成「去处理」。
  const questionBody = useMemo(() => askQuestionsOf(env?.questions), [env?.questions])
  const useAskCard = questionBody.length > 0
  const questionLabels = useMemo(() => {
    const first = questionBody[0] as { options?: Array<{ label?: unknown }> } | undefined
    if (!Array.isArray(first?.options)) return [] as string[]
    return first.options
      .map((option) => (typeof option?.label === 'string' ? option.label : ''))
      .filter((label): label is string => !!label)
  }, [questionBody])
  const [pick, setPick] = useState<number | null>(null)
  const [free, setFree] = useState('')
  const [busyChoice, setBusyChoice] = useState<string | null>(null)

  const { submit, busy, failed } = useAskSubmit({
    cabinId: entry.cabinId || entryCabinId,
    askId: env?.ask_id ?? item.id,
    ...(env?.author_session_id ? { authorSessionId: env.author_session_id } : {}),
    ...(item.handle ? { handle: item.handle } : {}),
    ...(item.task_id ? { taskId: item.task_id } : {}),
    optionLabels: options.length > 0 ? options.map((option) => option.label) : questionLabels,
    ...(env?.message_id ? { messageId: env.message_id } : {}),
    // 就地回复不偷偷转发：旧服务端只提示去线程。
    threadFallback: false,
  })

  /** 提交正文（扁平选项与卡片都汇到这里）：卡片自带 `用户回答了以下问题：…` 正文。 */
  const send = useCallback(async (content: string) => {
    if (!content.trim() || busy) return
    setBusyChoice(content)
    const outcome = await submit(content)
    setBusyChoice(null)
    if (outcome.ok) {
      onAnswered(item.id, outcome.choice ?? content)
      onDone()
    }
  }, [busy, item.id, onAnswered, onDone, submit])

  /** 扁平选项 / 自由输入 → 与 classic 问答窗同一段提交正文。 */
  const sendLabel = useCallback((label: string) => {
    void send(`用户回答了以下问题：\n\n1. [要定的事] ${env?.decision ?? item.question ?? '选择'}\n   → ${label}`)
  }, [env?.decision, item.question, send])

  const canInline = canAnswerInline(item)

  const synthetic = useMemo<ChatMessage | null>(() => {
    if (!useAskCard) return null
    return {
      id: `cockpit-inbox-ask-${item.id}`,
      sessionId: env?.author_session_id ?? '',
      role: 'assistant',
      displayType: 'ask_user_question',
      content: '',
      timestamp: '',
      toolCallId: `cockpit-inbox-ask-${item.id}`,
      toolName: 'AskUserQuestion',
      toolInput: env?.questions,
      toolStatus: 'done',
    }
  }, [useAskCard, item.id, env?.author_session_id, env?.questions])

  return (
    <div className="ck12-ipd" data-testid="cockpit-inbox-reply">
      <div className="ck12-ipd-h">
        <button
          type="button"
          className="ck12-ipx ck12-ipd-x"
          aria-label="收起要我处理"
          title="收起（Esc）"
          onClick={closeInbox}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ck12-ipd-back"
          aria-label="回到列表"
          title="回到列表"
          onClick={() => selectInbox(null)}
        >
          ←
        </button>
        <span className="ck12-ipd-k" data-kind={groupClass(entry)}>
          {item.handle ?? '待办'} · {groupClass(entry) === 'blk' ? '受阻' : groupClass(entry) === 'rev' ? '待验收' : '待你定'}
        </span>
        <span className="ck12-ipd-sp" />
      </div>

      <div className="ck12-ipd-body">
        <div className="ck12-ipd-job">{item.title}</div>
        {/* 卡片自己会印问题正文：这里不再重复一遍（repo / wt 照旧保留）。 */}
        {(item.repo || item.wt || (!useAskCard && item.question)) && (
          <div className="ck12-ipd-ctx">
            {[item.repo, item.wt, useAskCard ? null : item.question].filter(Boolean).join(' · ')}
          </div>
        )}
        {!useAskCard && (
          <div className="ck12-ipd-q">{env?.decision ?? item.question ?? attentionStageLabel(item)}</div>
        )}

        {useAskCard ? (
          <>
            <div className="ck12-ipd-qa" data-testid="cockpit-inbox-askcard">
              {synthetic && (
                <AskUserQuestionCard
                  message={synthetic}
                  onAnswer={(content) => void send(content)}
                  disabled={busy}
                  hideChatAbout
                  hotkeyId={item.id}
                />
              )}
            </div>
            <div className="ck12-ipn">勾选后提交；不跳作战线程，汐音就地转达执行者。</div>
          </>
        ) : canInline ? (
          <>
            <div className="ck12-ipd-opts" role="radiogroup" aria-label="选项">
              {options.map((option, index) => {
                const rec = env?.recommendation?.label === option.label
                return (
                  <button
                    key={`${option.label}-${index}`}
                    type="button"
                    role="radio"
                    aria-checked={pick === index}
                    className={`ck12-ipd-opt${pick === index ? ' is-on' : ''}`}
                    disabled={busy}
                    onClick={() => setPick(index)}
                  >
                    <span className="ck12-ipd-optn">[{index + 1}]</span>
                    <span className="ck12-ipd-opto">
                      <b>{option.label}</b>
                      {(option.impact || option.description) && (
                        <span>{option.impact ?? option.description}</span>
                      )}
                    </span>
                    {rec && <span className="ck12-ipd-rec">REC</span>}
                  </button>
                )
              })}
            </div>
            <div className="ck12-ipd-free">
              <input
                value={free}
                placeholder="或直接说你的定法…（⏎ 发送）"
                aria-label="自由作答"
                onChange={(event) => setFree(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    sendLabel(free)
                  }
                }}
              />
              <button type="button" disabled={busy || !free.trim()} onClick={() => sendLabel(free)}>
                发送
              </button>
            </div>
            <div className="ck12-ipn">选一项 → 提交；不跳作战线程，汐音就地转达执行者。</div>
          </>
        ) : (
          <>
            <div className="ck12-ipn">
              这条没有可拍板的选项（{attentionStageLabel(item)}）—— 去对应的作战面处理，处理完
              attention 会自己消项。详情在浮层左侧打开，浮层留着方便你连着看下一条。
            </div>
            <div className="ck12-ipd-free">
              <button
                type="button"
                className="ck12-ipd-deal"
                data-testid="cockpit-inbox-deal"
                onClick={() => onDeal(entry)}
              >
                ▦ 去处理 · 看作战详情 →
              </button>
            </div>
          </>
        )}

        {(failed || (busyChoice && !busy && failed)) && (
          <div className="ck12-ipd-err" data-testid="cockpit-inbox-error">{failed}</div>
        )}
      </div>

      <div className="ck12-ipd-foot">
        <button type="button" onClick={() => selectInbox(null)}>稍后</button>
        <span className="ck12-ipd-sp" />
        {canInline && (
          <button
            type="button"
            className="ck12-ipd-deal"
            data-testid="cockpit-inbox-ask-detail"
            onClick={() => onOpenDetail(entry)}
          >
            ▦ 看任务详情
          </button>
        )}
        <span className="ck12-ipd-cap">
          {useAskCard ? '在卡片上勾选' : canInline ? (pick == null && !free.trim() ? '先选一项' : '已选 · 可提交') : '去处理 ▦'}
        </span>
        {/* AskUserQuestion 卡自带「提交答案」；扁平选项才用这张按钮，避免双提交。 */}
        {!useAskCard && (
          <button
            type="button"
            className="ck12-ipd-pri"
            disabled={!canInline || busy || (pick == null && !free.trim())}
            onClick={() => sendLabel(pick != null ? options[pick].label : free)}
          >
            {busy ? '提交中…' : '提交回答'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 待放行就地卡（v21 七轮）：与问答卡同一副骨架，选项 = ready / trigger / resume。 */
function StartReplyCard({
  entry,
  onDecided,
  onOpenDetail,
}: {
  entry: InboxEntry
  /** 执行成功：乐观消项键（startDecisionKey）+ 回执文案。 */
  onDecided: (decisionKey: string, receipt: string) => void
  onOpenDetail: (entry: InboxEntry) => void
}) {
  const { closeInbox, selectInbox } = useCockpitState()
  const { item } = entry
  const kind = startKindOf(item)
  const options = startOptionsOf(kind)
  const taskId = item.task_id
  const [choice, setChoice] = useState<StartChoice>(options[0]?.id ?? 'enqueue')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const execute = useCallback(async () => {
    if (!taskId || busy) return
    setBusy(true)
    setError(null)
    try {
      if (choice === 'launch') {
        await readyTask(taskId, { silentCard: true })
        await triggerTask(taskId)
      } else if (choice === 'enqueue') {
        await readyTask(taskId)
      } else if (choice === 'trigger') {
        await triggerTask(taskId)
      } else {
        await resumeTask(taskId)
      }
      onDecided(startDecisionKey(item), START_RECEIPT_TEXT[choice])
    } catch (err) {
      setError(startErrorText(err))
    } finally {
      setBusy(false)
    }
  }, [busy, choice, item, onDecided, taskId])

  return (
    <div className="ck12-ipd" data-testid="cockpit-inbox-start">
      <div className="ck12-ipd-h">
        <button
          type="button"
          className="ck12-ipx ck12-ipd-x"
          aria-label="收起要我处理"
          title="收起（Esc）"
          onClick={closeInbox}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ck12-ipd-back"
          aria-label="回到列表"
          title="回到列表"
          onClick={() => selectInbox(null)}
        >
          ←
        </button>
        <span className="ck12-ipd-k" data-kind={groupClass(entry)}>
          {item.handle ?? '待办'} · 待放行
        </span>
        <span className="ck12-ipd-sp" />
      </div>

      <div className="ck12-ipd-body">
        <div className="ck12-ipd-job">⚑ {jobLine(entry)}</div>
        {(item.repo || item.wt) && (
          <div className="ck12-ipd-ctx">{[item.repo, item.wt].filter(Boolean).join(' · ')}</div>
        )}
        <div className="ck12-ipd-q">要现在放行吗？</div>
        <div className="ck12-ipn">{START_SUMMARY[kind]}</div>

        <div className="ck12-ipd-opts" role="radiogroup" aria-label="放行方式">
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={choice === option.id}
              className={`ck12-ipd-opt${choice === option.id ? ' is-on' : ''}`}
              data-testid={`cockpit-inbox-start-opt-${option.id}`}
              disabled={busy}
              onClick={() => setChoice(option.id)}
            >
              <span className="ck12-ipd-optn">[{index + 1}]</span>
              <span className="ck12-ipd-opto">
                <b>{option.label}</b>
                <span>{option.impact}</span>
              </span>
            </button>
          ))}
        </div>

        {error && (
          <div className="ck12-ipd-err" data-testid="cockpit-inbox-error">{error}</div>
        )}
        <div className="ck12-ipn">选一项 → 确认执行；汐音当场放行并回执。</div>
      </div>

      <div className="ck12-ipd-foot">
        <button type="button" onClick={() => selectInbox(null)}>稍后</button>
        <span className="ck12-ipd-sp" />
        <button
          type="button"
          className="ck12-ipd-deal"
          data-testid="cockpit-inbox-start-detail"
          onClick={() => onOpenDetail(entry)}
        >
          ▦ 看任务详情
        </button>
        <button
          type="button"
          className="ck12-ipd-pri"
          data-testid="cockpit-inbox-start-exec"
          disabled={busy || !taskId}
          onClick={() => void execute()}
        >
          {busy ? '执行中…' : '确认执行'}
        </button>
      </div>
    </div>
  )
}

/** 完成回流卡（2026-11-19 用户 #9）：执行完先进 inbox，汐音审一道；
 *  人也可以直接确认「不会回复了」——纯 ack，不回写任务/会话。 */
function NoticeReplyCard({
  entry,
  onAcked,
  onOpenDetail,
}: {
  entry: InboxEntry
  onAcked: (entry: InboxEntry) => void
  onOpenDetail: (entry: InboxEntry) => void
}) {
  const { closeInbox, selectInbox, entryCabinId } = useCockpitState()
  const { item } = entry
  const cabinId = entry.cabinId || entryCabinId
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ack = useCallback(async () => {
    if (busy || !cabinId) return
    setBusy(true)
    setError(null)
    try {
      await ackCabinAttention(cabinId, item.id)
      onAcked(entry)
    } catch (err) {
      setError(err instanceof Error ? err.message : '收项失败')
    } finally {
      setBusy(false)
    }
  }, [busy, cabinId, item.id, entry, onAcked])

  return (
    <div className="ck12-ipd" data-testid="cockpit-inbox-notice">
      <div className="ck12-ipd-h">
        <button
          type="button"
          className="ck12-ipx ck12-ipd-x"
          aria-label="收起要我处理"
          title="收起（Esc）"
          onClick={closeInbox}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ck12-ipd-back"
          aria-label="回到列表"
          title="回到列表"
          onClick={() => selectInbox(null)}
        >
          ←
        </button>
        <span className="ck12-ipd-k" data-kind={groupClass(entry)}>
          {item.handle ?? '完成'} · 已完成
        </span>
        <span className="ck12-ipd-sp" />
      </div>

      <div className="ck12-ipd-body">
        <div className="ck12-ipd-job">{item.title}</div>
        {(item.repo || item.wt || item.detail) && (
          <div className="ck12-ipd-ctx">
            {[item.repo, item.wt, item.detail].filter(Boolean).join(' · ')}
          </div>
        )}
        <div className="ck12-ipn">
          汐音已经审过这一条。确认不用回复 → 直接收下；不会回复任务/会话，也不会唤醒执行者。
          还想要个说法，就看详情或直接去主对话跟她说。
        </div>
        {error && <div className="ck12-ipd-err" data-testid="cockpit-inbox-error">{error}</div>}
      </div>

      <div className="ck12-ipd-foot">
        <button type="button" onClick={() => selectInbox(null)}>稍后</button>
        <span className="ck12-ipd-sp" />
        <button
          type="button"
          className="ck12-ipd-deal"
          data-testid="cockpit-inbox-notice-detail"
          onClick={() => onOpenDetail(entry)}
        >
          ▦ 看详情
        </button>
        <button
          type="button"
          className="ck12-ipd-pri"
          data-testid="cockpit-inbox-notice-ack"
          disabled={busy}
          onClick={() => void ack()}
        >
          {busy ? '收下中…' : '无需回复 · 收下'}
        </button>
      </div>
    </div>
  )
}

function ReceiptCard({
  entry,
  choice,
  kind = 'answer',
  onClose,
}: {
  entry: InboxEntry
  choice: string
  /** start = 放行回执；notice = 完成项已收下（未回复执行者）。 */
  kind?: 'answer' | 'start' | 'notice'
  onClose: () => void
}) {
  const started = kind === 'start'
  const noticed = kind === 'notice'
  return (
    <div className="ck12-ipd" data-testid="cockpit-inbox-receipt">
      <div className="ck12-ipd-h">
        <button
          type="button"
          className="ck12-ipx"
          aria-label="收起要我处理"
          title="收起（Esc）"
          onClick={onClose}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <span className="ck12-ipd-k" data-kind={groupClass(entry)}>
          {entry.item.handle ?? '待办'} · {noticed ? '已收下' : started ? '已放行' : '已答'}
        </span>
        <span className="ck12-ipd-sp" />
      </div>
      <div className="ck12-ipd-body">
        <div className="ck12-ipd-receipt">
          <div className="ck12-ipd-ok">✓ {noticed ? '已收下' : started ? '已放行' : '已答'} · {choice}</div>
          <div className="ck12-ipd-ans">{entry.item.question ?? entry.item.title}</div>
          <div className="ck12-ipn">
            {noticed
              ? '已从「要我处理」收项；没有回复任务/会话，执行者继续空闲。'
              : started
                ? '已按你的决定放行；这条从「要我处理」消项，编队状态跟着更新。'
                : '已转达执行者并写入账本；这条从「要我处理」消项，编队状态跟着更新。'}
          </div>
        </div>
      </div>
    </div>
  )
}

export interface CockpitInboxPopoverProps {
  entries: readonly InboxEntry[]
  counts: InboxCounts
  answered: ReadonlySet<string>
  onAnswered: (id: string, choice: string) => void
  /** 待放行执行成功：乐观消项（键含动作，见 startDecisionKey）+ 触发一次刷新。 */
  onStartDecided: (decisionKey: string) => void
}

export function CockpitInboxPopover({ entries, counts, answered, onAnswered, onStartDecided }: CockpitInboxPopoverProps) {
  const { inboxSel, selectInbox, closeInbox, openPanel, select, layer } = useCockpitState()
  const [receipt, setReceipt] = useState<{
    entry: InboxEntry
    choice: string
    kind: 'answer' | 'start' | 'notice'
  } | null>(null)

  const groups = useMemo(() => groupedInbox(entries, answered), [entries, answered])
  const selected = useMemo(
    () => entries.find((entry) => entry.item.id === inboxSel) ?? null,
    [entries, inboxSel],
  )
  // 选中的那条已被答掉 / 已从 attention 消失：回列表（回执照常显示）。
  useEffect(() => {
    if (inboxSel && !selected) selectInbox(null)
  }, [inboxSel, selected, selectInbox])

  // Esc：只走唯一 layer 栈。
  useEffect(() => layer.register('cockpit-inbox', INBOX_LAYER_PRIORITY, closeInbox), [layer, closeInbox])

  // 回执 1.4s 后回列表；全清后 0.7s 自动收起。
  useEffect(() => {
    if (!receipt) return
    const back = window.setTimeout(() => setReceipt(null), RECEIPT_MS)
    return () => window.clearTimeout(back)
  }, [receipt])

  useEffect(() => {
    if (receipt || counts.total > 0) return
    const close = window.setTimeout(() => closeInbox(), AUTO_CLOSE_MS)
    return () => window.clearTimeout(close)
  }, [receipt, counts.total, closeInbox])

  const deal = useCallback((entry: InboxEntry) => {
    // v21 七轮：详情首签 = 对话（任务的 chat 记录）——「去处理」也落到这里。
    // v22.3：来源标成 inbox —— 详情固定让到浮层左侧顺势打开（.is-aside-inbox），
    // 与放行卡「看任务详情」同一手感；回单栏列表，把宽度留给详情。
    select(entry.ref, 'dialog', 'inbox')
    selectInbox(null)
  }, [select, selectInbox])

  // 放行卡「看任务详情」：只开作战详情，**不关浮层** —— 人还能接着在这张卡上
  // 确认执行；浮层是 popover，点外面再收（用户反馈：点一下详情就把选中的窗口关了）。
  const openDetail = useCallback((entry: InboxEntry) => {
    select(entry.ref, 'dialog', 'inbox')
  }, [select])

  return (
    <div
      className={`ck12-inboxpop${selected || receipt ? ' is-two' : ''}`}
      data-testid="cockpit-inbox-popover"
      role="dialog"
      aria-label="要我处理"
    >
      {(receipt || selected) && (
        receipt
          ? (
            <ReceiptCard
              entry={receipt.entry}
              choice={receipt.choice}
              kind={receipt.kind}
              onClose={closeInbox}
            />
          )
          : selected && (
            selected.item.stage === 'start' ? (
              <StartReplyCard
                key={`start-${selected.item.id}`}
                entry={selected}
                onDecided={(decisionKey, text) => {
                  onStartDecided(decisionKey)
                  setReceipt({ entry: selected, choice: text, kind: 'start' })
                }}
                onOpenDetail={openDetail}
              />
            ) : selected.item.stage === 'notice' ? (
              <NoticeReplyCard
                key={`notice-${selected.item.id}`}
                entry={selected}
                onAcked={(entry) => {
                  onAnswered(entry.item.id, '无需回复')
                  setReceipt({ entry, choice: '无需回复', kind: 'notice' })
                }}
                onOpenDetail={openDetail}
              />
            ) : (
              <ReplyCard
                key={selected.item.id}
                entry={selected}
                onAnswered={(id, choice) => {
                  onAnswered(id, choice)
                  setReceipt({ entry: selected, choice, kind: 'answer' })
                }}
                onDone={() => selectInbox(null)}
                onDeal={deal}
                onOpenDetail={openDetail}
              />
            )
          )
      )}

      <div className="ck12-ip-listwrap">
        <div className="ck12-ip-h">
          <button
            type="button"
            className="ck12-ipx"
            aria-label="收起要我处理"
            title="收起（Esc）"
            onClick={closeInbox}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
          <span className="ck12-ip-t">要我处理</span>
          <b className="ck12-ip-total">{counts.total}</b>
          <span className="ck12-ip-brk">
            待你定 {counts.ask} · 验收 {counts.rev} · 受阻 {counts.blk} · 完成 {counts.done}
          </span>
        </div>

        <div className="ck12-ip-body">
          {groups.length === 0 ? (
            <div className="ck12-ip-empty" data-testid="cockpit-inbox-empty">
              <b>✓</b>都处理完了
            </div>
          ) : groups.map((group) => (
            <div key={group.group} className="ck12-ip-groupwrap">
              <div className="ck12-ip-group" data-group={group.group}>
                <span>{group.label}</span>
                <b>{group.items.length}</b>
              </div>
              {group.items.map((entry) => {
                const on = entry.item.id === inboxSel
                const shortName = jobLine(entry)
                return (
                  <button
                    key={entry.item.id}
                    type="button"
                    className={`ck12-ip-row${on ? ' is-on' : ''}`}
                    data-testid={`cockpit-inbox-row-${entry.item.id}`}
                    data-group={groupClass(entry)}
                    onClick={() => selectInbox(entry.item.id)}
                  >
                    <span className="ck12-ip-r1">
                      <span className={`ck12-ip-type is-${groupClass(entry)}`}>
                        {entry.item.handle ?? '#'}
                      </span>
                      <span className="ck12-ip-name">{shortName}</span>
                      <span className="ck12-ip-go">{inboxVerb(entry.item)}</span>
                    </span>
                    <span className="ck12-ip-q">{entry.item.question ?? entry.item.detail ?? entry.item.title}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="ck12-ip-foot">
          <button type="button" onClick={() => openPanel('ops')}>▦ 全部决断 →</button>
          <span className="ck12-ip-sp" />
          Esc 收起 · 处理完自动回来
        </div>
      </div>
    </div>
  )
}
