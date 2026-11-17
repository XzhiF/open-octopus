'use client'

// v20（design 29 §3.1/§6）：TUI 选项行 —— 当前线程的「待你决断」就地菜单。
//
// 真数据：attention 里 awaiting=person 且归属当前线程的行；带决策信封
// （design 26）的行渲染 options + impact + REC，就地走 useAskSubmit（与问答窗
// 同一管线，票据 askId 唯一权威）；没有信封的行（验收/审批/裁决）给一条
// 「去处理」入口跳真实面（验收页签 / attention 面），不假造选项。
// 键盘 1–9 直达（焦点在输入框 / 模态面板开着时不抢键）。

import { useEffect, useMemo } from 'react'
import type { CabinAttentionItem } from '@octopus/shared'
import { useAskSubmit } from '@/components/cabin/asks/ask-submit'
import { useAskWindows } from '@/components/cabin/asks/ask-windows-provider'
import { attentionStageLabel } from '../fx/CockpitBrief'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { threadKeyOfAttention } from '../fleet/threads-model'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitRef } from '../state/cockpit-state'
import { useCockpitThreads } from './use-cockpit-threads'

function openItemsForThread(
  rows: Parameters<typeof threadKeyOfAttention>[0],
  threadKey: string,
): CabinAttentionItem[] {
  const items: CabinAttentionItem[] = []
  for (const row of rows) {
    const item = row.kind === 'job' ? row.attention : row.kind === 'attention' ? row.item : null
    if (!item || item.awaiting !== 'person') continue
    if (threadKeyOfAttention(rows, item) === threadKey) items.push(item)
  }
  return items.sort((a, b) => b.priority - a.priority)
}

function refOfItem(item: CabinAttentionItem, cabinId: string): CockpitRef {
  if (item.subject?.kind === 'task') return { kind: 'task', cabinId, id: item.subject.id }
  if (item.job_id) return { kind: 'job', cabinId, id: item.job_id }
  if (item.task_id) return { kind: 'task', cabinId, id: item.task_id }
  return { kind: 'attention', cabinId, id: item.id }
}

interface ChoiceAction {
  item: CabinAttentionItem
  optionLabel: string | null
}

function ChoiceOptionRow({
  item,
  label,
  impact,
  rec,
  index,
}: {
  item: CabinAttentionItem
  label: string
  impact?: string
  rec: boolean
  index: number
}) {
  const { entryCabinId } = useCockpitState()
  const { markAnswered } = useAskWindows()
  const env = item.ask
  const { submit, busy } = useAskSubmit({
    cabinId: entryCabinId,
    askId: env?.ask_id ?? item.id,
    authorSessionId: env?.author_session_id,
    handle: item.handle,
    taskId: item.task_id ?? item.subject?.id,
    taskName: item.title,
    messageId: env?.message_id,
    optionLabels: env?.options?.map((o) => o.label) ?? [],
    threadFallback: false,
  })

  return (
    <button
      type="button"
      className="ck12-choice-row"
      data-testid={`cockpit-choice-${index + 1}`}
      disabled={busy}
      onClick={() => {
        void submit(`→ ${label}`).then((outcome) => {
          if (outcome.ok && env) markAnswered(env.ask_id)
        })
      }}
    >
      <span className="ck12-choice-no">[{index + 1}]</span>
      <span className="ck12-choice-label">{label}</span>
      {impact && <span className="ck12-choice-impact">· {impact}</span>}
      {rec && <span className="ck12-choice-rec">REC</span>}
    </button>
  )
}

function ChoiceItemBlock({
  item,
  startIndex,
}: {
  item: CabinAttentionItem
  startIndex: number
}) {
  const { entryCabinId, select } = useCockpitState()
  const { open: openAsk } = useAskWindows()
  const env = item.ask
  const options = env?.options ?? []

  const jump = () => {
    if (env) {
      openAsk(env.ask_id)
      return
    }
    select(refOfItem(item, entryCabinId), item.stage === 'review' ? 'accept' : 'overview')
  }

  return (
    <div className="ck12-choice-item" data-testid={`cockpit-choice-item-${item.id}`}>
      <button type="button" className="ck12-choice-head" onClick={jump}>
        <span className="ck12-choice-no">{options.length ? '◈' : `[${startIndex + 1}]`}</span>
        <span className="ck12-choice-label">{item.title}</span>
        <span className="ck12-choice-impact">· {attentionStageLabel(item)}</span>
        {!options.length && <span className="ck12-choice-rec">去处理 ▦</span>}
      </button>
      {options.map((option, i) => (
        <ChoiceOptionRow
          key={option.label}
          item={item}
          label={option.label}
          impact={option.impact ?? option.description}
          rec={env?.recommendation?.label === option.label}
          index={startIndex + i}
        />
      ))}
    </div>
  )
}

export function CockpitChoices({ threadKey, interactive = true }: { threadKey?: string; interactive?: boolean }) {
  const { rows } = useCockpitFleet()
  const { entryCabinId, select, chatWindow, panel } = useCockpitState()
  const { open: openAsk } = useAskWindows()
  const { active, byKey } = useCockpitThreads()
  const key = threadKey ?? active.key
  const thread = byKey.get(key) ?? active

  const items = useMemo(() => openItemsForThread(rows, thread.key), [rows, thread.key])
  const actions = useMemo<ChoiceAction[]>(
    () => items.flatMap((item): ChoiceAction[] => (
      item.ask?.options?.length
        ? item.ask.options.map((option) => ({ item, optionLabel: option.label }))
        : [{ item, optionLabel: null }]
    )),
    [items],
  )

  // 键盘 1–9：与渲染同一份 actions 顺序；输入框 / 模态里不抢键。
  // 弹出窗里的实例 interactive=false（键只归主通讯台）。
  useEffect(() => {
    if (!actions.length || !interactive) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (panel || !chatWindow.open || chatWindow.mini || chatWindow.docked) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const n = Number(event.key)
      if (!Number.isInteger(n) || n < 1 || n > actions.length) return
      event.preventDefault()
      const action = actions[n - 1]
      if (action.optionLabel) {
        // 选项拍板走 DOM click（复用 ChoiceOptionRow 的 submit 管线）。
        document.querySelector<HTMLButtonElement>(`[data-testid="cockpit-choice-${n}"]`)?.click()
        return
      }
      if (action.item.ask) openAsk(action.item.ask.ask_id)
      else select(refOfItem(action.item, entryCabinId), action.item.stage === 'review' ? 'accept' : 'overview')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, interactive, panel, chatWindow, openAsk, select, entryCabinId])

  if (!actions.length) return null

  let cursor = 0
  return (
    <div className="ck12-comms-choices" data-testid="cockpit-choices">
      <div className="ck12-choices-h">待你决断 · {actions.length} 项 · 键 1–9 直达</div>
      {items.map((item) => {
        const start = cursor
        cursor += item.ask?.options?.length ? item.ask.options.length : 1
        return <ChoiceItemBlock key={item.id} item={item} startIndex={start} />
      })}
    </div>
  )
}
