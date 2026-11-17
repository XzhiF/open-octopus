'use client'

// v20（design 29 §6 ops）：决断队列面板 —— open 按 priority 排序卡 +
// 消项卡（✓ choice，2.6s 后折叠）。真数据 = attention awaiting=person；
// 就地回答走问答窗 / 验收面（真实 resolve 表面），不假造选项提交。
// 回传卡 arrived 弹入（flash 锚点 = 编队行 key）。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CabinAttentionItem } from '@octopus/shared'
import { useAskWindows } from '@/components/cabin/asks/ask-windows-provider'
import { attentionStageLabel } from '../fx/CockpitBrief'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { threadKeyOfAttention, THREAD_EMO, threadStateOf } from '../fleet/threads-model'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitRef } from '../state/cockpit-state'
import { CockpitPanelShell } from './CockpitPanelShell'

const DONE_MS = 2_600

interface DoneCard {
  id: string
  title: string
  choice: string | null
  at: number
}

function refOfItem(item: CabinAttentionItem, cabinId: string): CockpitRef {
  if (item.subject?.kind === 'task') return { kind: 'task', cabinId, id: item.subject.id }
  if (item.job_id) return { kind: 'job', cabinId, id: item.job_id }
  if (item.task_id) return { kind: 'task', cabinId, id: item.task_id }
  return { kind: 'attention', cabinId, id: item.id }
}

export function CockpitOpsPanel() {
  const { rows } = useCockpitFleet()
  const { entryCabinId, select, closePanel, flash, threads: api } = useCockpitState()
  const { open: openAsk } = useAskWindows()

  const open = useMemo(() => {
    const byId = new Map<string, { item: CabinAttentionItem; rowKey: string }>()
    for (const row of rows) {
      const item = row.kind === 'job' ? row.attention : row.kind === 'attention' ? row.item : null
      if (!item || item.awaiting !== 'person') continue
      if (!byId.has(item.id)) byId.set(item.id, { item, rowKey: row.key })
    }
    return [...byId.values()].sort((a, b) => b.item.priority - a.item.priority)
  }, [rows])

  // ── 消项卡：open 里消失的 id → ✓ 卡 2.6s；choice 取真实 answered 事件 ──
  const [done, setDone] = useState<DoneCard[]>([])
  const prevOpenRef = useRef<Map<string, string> | null>(null)
  const choiceRef = useRef<Map<string, string>>(new Map())
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    const onAnswered = (event: Event) => {
      const detail = (event as CustomEvent<{ askMessageId?: string; choice?: string }>).detail
      if (detail?.askMessageId && detail.choice) choiceRef.current.set(detail.askMessageId, detail.choice)
    }
    window.addEventListener('octopus:author-ask-answered', onAnswered)
    return () => window.removeEventListener('octopus:author-ask-answered', onAnswered)
  }, [])

  useEffect(() => {
    const current = new Map(open.map(({ item }) => [item.id, item.title] as const))
    const prev = prevOpenRef.current
    prevOpenRef.current = current
    if (!prev) return
    const gone: DoneCard[] = []
    for (const [id, title] of prev) {
      if (current.has(id)) continue
      const askId = id.startsWith('ask-') ? id.slice(4) : null
      gone.push({ id, title, choice: (askId && choiceRef.current.get(askId)) || null, at: Date.now() })
    }
    if (!gone.length) return
    setDone((prevDone) => [...prevDone, ...gone])
    for (const card of gone) {
      const timer = window.setTimeout(() => {
        setDone((prevDone) => prevDone.filter((c) => c.id !== card.id))
      }, DONE_MS)
      timersRef.current.push(timer)
    }
  }, [open])

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
  }, [])

  const answer = (item: CabinAttentionItem) => {
    closePanel()
    if (item.ask) {
      openAsk(item.ask.ask_id)
      return
    }
    select(refOfItem(item, entryCabinId), item.stage === 'review' ? 'accept' : 'overview')
  }

  const detail = (item: CabinAttentionItem) => {
    closePanel()
    select(refOfItem(item, entryCabinId), item.stage === 'review' ? 'accept' : 'overview')
  }

  return (
    <CockpitPanelShell kind="ops" title="决断" en="DECISIONS">
      {open.length === 0 && done.length === 0 && (
        <div className="ck12-ops-empty" data-testid="cockpit-ops-empty">
          <b>✓ 全舱无待办</b>
          没有要您决断的事 · 汐音盯着编队
        </div>
      )}
      {open.map(({ item, rowKey }, index) => {
        const arrived = flash.key === rowKey && Date.now() - flash.at < 1400
        const row = rows.find((r) => r.key === rowKey)
        const state = row ? threadStateOf(row) : 'wait'
        return (
          <div
            key={item.id}
            className={`ck12-ops-card${arrived ? ` is-arrived-${flash.nonce % 2}` : ''}`}
            data-testid={`cockpit-ops-card-${item.id}`}
          >
            <div className="ck12-ops-h">
              <span className="ck12-ops-no">#{index + 1}</span>
              {item.handle && <span className="ck12-ops-handle">{item.handle}</span>}
              <span className="ck12-ops-emo" aria-hidden="true">{THREAD_EMO[state]}</span>
              <b>{item.title}</b>
              <span className="ck12-ops-stage">{attentionStageLabel(item)}</span>
            </div>
            {(item.question || item.detail) && (
              <div className="ck12-ops-q">{item.question ?? item.detail}</div>
            )}
            {item.ask?.options && item.ask.options.length > 0 && (
              <div className="ck12-ops-opts">
                {item.ask.options.map((option) => (
                  <span key={option.label} className="ck12-ops-opt">
                    {option.label}
                    {item.ask?.recommendation?.label === option.label && <i>REC</i>}
                  </span>
                ))}
              </div>
            )}
            <div className="ck12-ops-f">
              <button type="button" className="ck12-ops-go" onClick={() => answer(item)}>
                就地回答 →
              </button>
              <button type="button" className="ck12-ops-detail" onClick={() => detail(item)}>
                ▦ 详情
              </button>
              <span className="ck12-ops-pri">pri {item.priority}</span>
            </div>
          </div>
        )
      })}
      {done.map((card) => (
        <div key={card.id} className="ck12-ops-card is-done" data-testid={`cockpit-ops-done-${card.id}`}>
          <div className="ck12-ops-h">
            <span className="ck12-ops-ok">✓</span>
            <b>{card.title}</b>
            {card.choice && <span className="ck12-ops-choice">按「{card.choice}」交代下去</span>}
          </div>
        </div>
      ))}
      <div className="ck12-ops-foot">
        消项走真实决策端点 · 主对话会落「✓ 按…交代下去」回执
        {api.unread.main ? ` · 主对话 ${api.unread.main} 未读` : ''}
      </div>
    </CockpitPanelShell>
  )
}
