'use client'

// v21（design 31 §3.2.2）· 「要我处理」浮层 —— v22 #5 起是**单栏一级列表**。
//
// 2026-11-23 用户：不要二级「回复卡」包装。一级行直接给动作：
//   · 💬 对话 = 打开这条作战的独立 chat 窗，AskUserQuestion 原样在 chat 里答；
//   · ▦ 详情 = 作战详情（验收行落「验收」页签，其余落「运行」）；
//   · 待放行（start）/ 完成回流（notice）聊天里答不了 —— 仍是一张就地小卡
//     （放行：ready / trigger / resume；完成：无需回复 · 收下）。
// 行体点击 = 按类型走默认动作：ask/blocked → 对话；验收 → 验收详情；放行 / 完成 → 卡片。
//
// 浮层**只手动关**（✕ / Esc），不自动收起；动作里开详情/对话按原型语义决定
// 留不留浮层（看详情留着，去对话收掉）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { ackCabinAttention, dismissCabinAsk } from '@/lib/cabin-api'
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
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitThreads } from '../chat/use-cockpit-threads'
import { openFleetChat } from '../chat/open-fleet-window'
import { threadKeyOfAttention } from '../fleet/threads-model'
import {
  groupedInbox,
  inboxGroupOf,
  type InboxCounts,
  type InboxEntry,
  type InboxGroup,
} from './inbox-model'

/** 比聊天浮窗（60）/ 编队抽屉（70）/ 问答窗（100）都高：Esc 先收这张浮层。 */
const INBOX_LAYER_PRIORITY = 120
const RECEIPT_MS = 1400

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

function isCardStage(entry: InboxEntry | null): boolean {
  return entry?.item.stage === 'start' || entry?.item.stage === 'notice'
}

/** 待放行就地卡：放行 = 任务生命周期动作，不在 chat 里回答。 */
function StartReplyCard({
  entry,
  onDecided,
  onOpenDetail,
  onOpenChat,
}: {
  entry: InboxEntry
  /** 执行成功：乐观消项键（startDecisionKey）+ 回执文案。 */
  onDecided: (decisionKey: string, receipt: string) => void
  onOpenDetail: (entry: InboxEntry) => void
  onOpenChat: (entry: InboxEntry) => void
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
          className="ck12-ipd-deal"
          data-testid="cockpit-inbox-start-chat"
          onClick={() => onOpenChat(entry)}
        >
          💬 去对话
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
  onOpenChat,
}: {
  entry: InboxEntry
  onAcked: (entry: InboxEntry) => void
  onOpenDetail: (entry: InboxEntry) => void
  onOpenChat: (entry: InboxEntry) => void
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
          还想要个说法，就看详情或直接去这条作战的对话。
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
          className="ck12-ipd-deal"
          data-testid="cockpit-inbox-notice-chat"
          onClick={() => onOpenChat(entry)}
        >
          💬 去对话
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
  kind = 'start',
  onClose,
}: {
  entry: InboxEntry
  choice: string
  /** start = 放行回执；notice = 完成项已收下（未回复执行者）。 */
  kind?: 'start' | 'notice'
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
  const {
    inboxSel, selectInbox, closeInbox, openPanel, select, layer, wins, chatWindow, threads: threadApi,
    entryCabinId,
  } = useCockpitState()
  const { rows } = useCockpitFleet()
  const { byKey } = useCockpitThreads()
  const [receipt, setReceipt] = useState<{
    entry: InboxEntry
    choice: string
    kind: 'start' | 'notice'
  } | null>(null)

  const groups = useMemo(() => groupedInbox(entries, answered), [entries, answered])
  const selected = useMemo(
    () => entries.find((entry) => entry.item.id === inboxSel) ?? null,
    [entries, inboxSel],
  )
  // 卡片态只留给放行 / 完成回流；ask / 验收已答掉或不在 attention 里 → 回列表。
  useEffect(() => {
    if (inboxSel && (!selected || !isCardStage(selected))) selectInbox(null)
  }, [inboxSel, selected, selectInbox])

  // Esc：只走唯一 layer 栈。
  useEffect(() => layer.register('cockpit-inbox', INBOX_LAYER_PRIORITY, closeInbox), [layer, closeInbox])

  // 回执 1.4s 后回列表。浮层**只手动关**（✕ / Esc）。
  useEffect(() => {
    if (!receipt) return
    const back = window.setTimeout(() => setReceipt(null), RECEIPT_MS)
    return () => window.clearTimeout(back)
  }, [receipt])

  /** 详情：验收行落「验收」，其余落「运行」；从 inbox 打开 → 让到浮层左侧。
   *  浮层留着（人还能接着看下一条）。 */
  const openDetail = useCallback((entry: InboxEntry, tab: 'accept' | 'run' = 'run') => {
    select(entry.ref, tab, 'inbox')
  }, [select])

  /** 对话：打开这条作战的独立 chat 窗（浮层收掉）。没有会话的行退回详情。 */
  const openChat = useCallback((entry: InboxEntry) => {
    const key = threadKeyOfAttention(rows, entry.item)
      ?? (byKey.has(entry.rowKey) ? entry.rowKey : null)
    closeInbox()
    if (key && byKey.has(key)) {
      openFleetChat(wins, threadApi, key, chatWindow)
      return
    }
    select(entry.ref, 'run', 'inbox')
  }, [rows, byKey, closeInbox, wins, threadApi, chatWindow, select])

  /** 忽略提问（v22 #9）：不回复、不转达。消息卡写 decision（dismiss）+ attention
   *  收项（ack）—— 状态派生的委派行 / 工作流提问没有消息卡，只靠 ack 也能立刻
   *  从「要我处理」收起；人若改主意，去这条作战的对话里直接说就行。 */
  const ignoreAsk = useCallback(async (entry: InboxEntry) => {
    const cabinId = entry.cabinId || entryCabinId
    const askId = entry.item.ask?.ask_id
    try {
      if (askId) await dismissCabinAsk(cabinId, askId)
      await ackCabinAttention(cabinId, entry.item.id)
      onAnswered(entry.item.id, '已忽略')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '忽略失败')
    }
  }, [entryCabinId, onAnswered])

  /** 行体默认动作（原型 inboxGo）。 */
  const go = useCallback((entry: InboxEntry) => {
    const group = groupClass(entry)
    if (entry.item.stage === 'start' || group === 'done') {
      selectInbox(entry.item.id)
      return
    }
    if (group === 'rev') {
      closeInbox()
      openDetail(entry, 'accept')
      return
    }
    openChat(entry)
  }, [closeInbox, openChat, openDetail, selectInbox])

  // 卡片态：放行 / 完成回流（单栏）。
  if (receipt) {
    return (
      <div className="ck12-inboxpop" data-testid="cockpit-inbox-popover" role="dialog" aria-label="要我处理">
        <ReceiptCard
          entry={receipt.entry}
          choice={receipt.choice}
          kind={receipt.kind}
          onClose={closeInbox}
        />
      </div>
    )
  }
  if (selected && isCardStage(selected)) {
    return (
      <div className="ck12-inboxpop" data-testid="cockpit-inbox-popover" role="dialog" aria-label="要我处理">
        {selected.item.stage === 'start' ? (
          <StartReplyCard
            key={`start-${selected.item.id}`}
            entry={selected}
            onDecided={(decisionKey, text) => {
              onStartDecided(decisionKey)
              setReceipt({ entry: selected, choice: text, kind: 'start' })
            }}
            onOpenDetail={(entry) => openDetail(entry, 'run')}
            onOpenChat={openChat}
          />
        ) : (
          <NoticeReplyCard
            key={`notice-${selected.item.id}`}
            entry={selected}
            onAcked={(entry) => {
              onAnswered(entry.item.id, '无需回复')
              setReceipt({ entry, choice: '无需回复', kind: 'notice' })
            }}
            onOpenDetail={(entry) => openDetail(entry, 'run')}
            onOpenChat={openChat}
          />
        )}
      </div>
    )
  }

  return (
    <div
      className="ck12-inboxpop"
      data-testid="cockpit-inbox-popover"
      role="dialog"
      aria-label="要我处理"
    >
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
                const groupKey = groupClass(entry)
                const actions = entry.item.stage === 'start' ? (
                  <>
                    <button
                      type="button"
                      className="ck12-ipa is-pri"
                      title="放行 / 入列 / 恢复"
                      data-testid={`cockpit-inbox-start-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        selectInbox(entry.item.id)
                      }}
                    >
                      ⚑ 放行
                    </button>
                    <button
                      type="button"
                      className="ck12-ipa"
                      title="作战详情"
                      data-testid={`cockpit-inbox-detail-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openDetail(entry, 'run')
                      }}
                    >
                      ▦
                    </button>
                  </>
                ) : groupKey === 'rev' ? (
                  <>
                    <button
                      type="button"
                      className="ck12-ipa is-pri"
                      title="看验收（作战详情）"
                      data-testid={`cockpit-inbox-detail-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openDetail(entry, 'accept')
                      }}
                    >
                      ▦ 验收
                    </button>
                    <button
                      type="button"
                      className="ck12-ipa"
                      title="去这条作战的对话"
                      data-testid={`cockpit-inbox-chat-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openChat(entry)
                      }}
                    >
                      💬
                    </button>
                  </>
                ) : groupKey === 'done' ? (
                  <>
                    <button
                      type="button"
                      className="ck12-ipa is-pri"
                      title="收下 · 无需回复"
                      data-testid={`cockpit-inbox-ack-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        selectInbox(entry.item.id)
                      }}
                    >
                      ✓ 收下
                    </button>
                    <button
                      type="button"
                      className="ck12-ipa"
                      title="作战详情"
                      data-testid={`cockpit-inbox-detail-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openDetail(entry, 'run')
                      }}
                    >
                      ▦
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ck12-ipa is-pri"
                      title="直接去这条作战的 chat 里回答"
                      data-testid={`cockpit-inbox-chat-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openChat(entry)
                      }}
                    >
                      💬 对话
                    </button>
                    {groupKey === 'ask' && (
                      <button
                        type="button"
                        className="ck12-ipa"
                        title="忽略这条提问（不回复 · 从要我处理收起）"
                        data-testid={`cockpit-inbox-ignore-${entry.item.id}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          void ignoreAsk(entry)
                        }}
                      >
                        忽略
                      </button>
                    )}
                    <button
                      type="button"
                      className="ck12-ipa"
                      title="作战详情"
                      data-testid={`cockpit-inbox-detail-${entry.item.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openDetail(entry, 'run')
                      }}
                    >
                      ▦
                    </button>
                  </>
                )
                return (
                  <div
                    key={entry.item.id}
                    role="button"
                    tabIndex={0}
                    className="ck12-ip-row"
                    data-testid={`cockpit-inbox-row-${entry.item.id}`}
                    data-group={groupKey}
                    onClick={() => go(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        go(entry)
                      }
                    }}
                  >
                    <span className="ck12-ip-r1">
                      <span className={`ck12-ip-type is-${groupKey}`}>
                        {entry.item.handle ?? '#'}
                      </span>
                      <span className="ck12-ip-name">{jobLine(entry)}</span>
                      <span className="ck12-ip-acts">{actions}</span>
                    </span>
                    <span className="ck12-ip-q">{entry.item.question ?? entry.item.detail ?? entry.item.title}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="ck12-ip-foot">
          <button type="button" onClick={() => openPanel('ops')}>▦ 全部决断 →</button>
          <span className="ck12-ip-sp" />
          点行进对话 · Esc 收起
        </div>
      </div>
    </div>
  )
}
