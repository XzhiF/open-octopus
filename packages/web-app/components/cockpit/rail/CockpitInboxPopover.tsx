'use client'

// v21（design 31 §3.2.2）· 「要我处理」浮层：列表在右、回复卡在左。
//
// 就地回：点一条 → 左侧开回复卡（两栏）→ 选项 / 自由输入 → 走 useAskSubmit
// 真决策管线 → 回执 1.4s → 回列表；全清后 0.7s 自动收起。
// **不跳作战线程** —— 这是 v21 与 v20 决断面板的关键区别（面板仍作为「全部决断」）。
// 没有决策信封的行不假造选项，只给「去处理 ▦」（打开作业面 / attention 面）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAskSubmit } from '@/components/cabin/asks/ask-submit'
import { useCockpitState } from '../state/CockpitStateProvider'
import { attentionStageLabel } from '../fx/CockpitBrief'
import {
  canAnswerInline,
  groupedInbox,
  inboxGroupOf,
  inboxVerb,
  type InboxCounts,
  type InboxEntry,
} from './inbox-model'

/** 比聊天浮窗（60）/ 编队抽屉（70）/ 问答窗（100）都高：Esc 先收这张浮层。 */
const INBOX_LAYER_PRIORITY = 120
const RECEIPT_MS = 1400
const AUTO_CLOSE_MS = 700

function groupClass(entry: InboxEntry): 'ask' | 'rev' | 'blk' {
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
}

function ReplyCard({ entry, onAnswered, onDone, onDeal }: ReplyCardProps) {
  const { closeInbox, selectInbox, entryCabinId } = useCockpitState()
  const { item } = entry
  const env = item.ask
  const options = useMemo(() => env?.options ?? [], [env?.options])
  const [pick, setPick] = useState<number | null>(null)
  const [free, setFree] = useState('')
  const [busyChoice, setBusyChoice] = useState<string | null>(null)

  const { submit, busy, failed } = useAskSubmit({
    cabinId: entry.cabinId || entryCabinId,
    askId: env?.ask_id ?? item.id,
    ...(env?.author_session_id ? { authorSessionId: env.author_session_id } : {}),
    ...(item.handle ? { handle: item.handle } : {}),
    ...(item.task_id ? { taskId: item.task_id } : {}),
    optionLabels: options.map((option) => option.label),
    ...(env?.message_id ? { messageId: env.message_id } : {}),
    // 就地回复不偷偷转发：旧服务端只提示去线程。
    threadFallback: false,
  })

  const send = useCallback(async (label: string) => {
    if (!label.trim() || busy) return
    setBusyChoice(label)
    const outcome = await submit(`用户回答了以下问题：\n\n1. [要定的事] ${env?.decision ?? item.question ?? '选择'}\n   → ${label}`)
    setBusyChoice(null)
    if (outcome.ok) {
      onAnswered(item.id, outcome.choice ?? label)
      onDone()
    }
  }, [busy, env?.decision, item.id, item.question, onAnswered, onDone, submit])

  const canInline = canAnswerInline(item)

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
        {(item.repo || item.wt || item.question) && (
          <div className="ck12-ipd-ctx">
            {[item.repo, item.wt, item.question].filter(Boolean).join(' · ')}
          </div>
        )}
        <div className="ck12-ipd-q">{env?.decision ?? item.question ?? attentionStageLabel(item)}</div>

        {canInline ? (
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
                    void send(free)
                  }
                }}
              />
              <button type="button" disabled={busy || !free.trim()} onClick={() => void send(free)}>
                发送
              </button>
            </div>
            <div className="ck12-ipn">选一项 → 提交；不跳作战线程，汐音就地转达执行者。</div>
          </>
        ) : (
          <>
            <div className="ck12-ipn">
              这条没有可拍板的选项（{attentionStageLabel(item)}）—— 去对应的作战面处理，处理完
              attention 会自己消项。
            </div>
            <div className="ck12-ipd-free">
              <button
                type="button"
                className="ck12-ipd-deal"
                onClick={() => onDeal(entry)}
              >
                ▦ 去处理 →
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
        <span className="ck12-ipd-cap">
          {canInline ? (pick == null && !free.trim() ? '先选一项' : '已选 · 可提交') : '去处理 ▦'}
        </span>
        <button
          type="button"
          className="ck12-ipd-pri"
          disabled={!canInline || busy || (pick == null && !free.trim())}
          onClick={() => void send(pick != null ? options[pick].label : free)}
        >
          {busy ? '提交中…' : '提交回答'}
        </button>
      </div>
    </div>
  )
}

function ReceiptCard({
  entry,
  choice,
  onClose,
}: {
  entry: InboxEntry
  choice: string
  onClose: () => void
}) {
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
        <span className="ck12-ipd-k" data-kind={groupClass(entry)}>{entry.item.handle ?? '待办'} · 已答</span>
        <span className="ck12-ipd-sp" />
      </div>
      <div className="ck12-ipd-body">
        <div className="ck12-ipd-receipt">
          <div className="ck12-ipd-ok">✓ 已答 · {choice}</div>
          <div className="ck12-ipd-ans">{entry.item.question ?? entry.item.title}</div>
          <div className="ck12-ipn">
            已转达执行者并写入账本；这条从「要我处理」消项，编队状态跟着更新。
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
}

export function CockpitInboxPopover({ entries, counts, answered, onAnswered }: CockpitInboxPopoverProps) {
  const { inboxSel, selectInbox, closeInbox, openPanel, select, layer } = useCockpitState()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [receipt, setReceipt] = useState<{ entry: InboxEntry; choice: string } | null>(null)

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

  // 点浮层外收起。chip 自己 toggle，不在这里误关。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target
      if (!(node instanceof Element)) return
      if (rootRef.current?.contains(node)) return
      if (node.closest('[data-testid="cockpit-inbox-chip"]')) return
      closeInbox()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [closeInbox])

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
    select(entry.ref)
    closeInbox()
  }, [select, closeInbox])

  return (
    <div
      ref={rootRef}
      className={`ck12-inboxpop${selected || receipt ? ' is-two' : ''}`}
      data-testid="cockpit-inbox-popover"
      role="dialog"
      aria-label="要我处理"
    >
      {(receipt || selected) && (
        receipt
          ? <ReceiptCard entry={receipt.entry} choice={receipt.choice} onClose={closeInbox} />
          : selected && (
            <ReplyCard
              key={selected.item.id}
              entry={selected}
              onAnswered={(id, choice) => {
                onAnswered(id, choice)
                setReceipt({ entry: selected, choice })
              }}
              onDone={() => selectInbox(null)}
              onDeal={deal}
            />
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
            待你定 {counts.ask} · 验收 {counts.rev} · 受阻 {counts.blk}
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
