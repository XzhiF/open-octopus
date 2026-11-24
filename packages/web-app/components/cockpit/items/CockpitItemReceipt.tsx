'use client'

// 事项回执卡（2026-11-24 用户）：汐音做完一组投递后，在转录里举上来的关项确认。
//
// 位置：挂在「带 via='items' 的那条 user message」之后（ChatPane 的 messageExtras）。
// 时机：该消息之后已经有一条 assistant 消息（本轮收口）才出现 —— 流式过程中不抢戏。
// 数据：行内状态直接读事项 store（同一份缓存），所以完成 / 搁置后卡片即时收口，
//       刷新 / 换设备后只要消息 metadata 还在、事项还没关，卡片就会重新举上来。
// 动作：完成 / 搁置 = close API；记录留在事项窗「记录」页签，不删消息。

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { AgentMessage } from '@/lib/agent/types'
import type { CabinItemDTO } from '@octopus/shared'
import { cabinAudio } from '@/lib/cabin-audio'
import { closeItemsRemote, isItemOpen, useCabinItems } from './items-store'

const STATUS_LABEL: Record<CabinItemDTO['status'], string> = {
  todo: '未决',
  delivered: '待确认',
  done: '已完成',
  dropped: '已搁置',
}

export interface CockpitItemReceiptProps {
  cabinId: string
  message: AgentMessage
  messages: AgentMessage[]
}

export function CockpitItemReceipt({ cabinId, message, messages }: CockpitItemReceiptProps) {
  const { items, loaded } = useCabinItems(cabinId)
  const [saving, setSaving] = useState<'done' | 'dropped' | null>(null)

  const list = useMemo(() => {
    const ids = message.via === 'items' && Array.isArray(message.items) ? message.items : []
    if (ids.length === 0) return []
    const byId = new Map(items.map((item) => [item.id, item]))
    return ids.map((id) => byId.get(id)).filter((item): item is CabinItemDTO => !!item)
      .sort((a, b) => a.seq - b.seq)
  }, [message.via, message.items, items])

  // 本轮已收口：这条投递之后至少有一条 assistant 行。
  const answered = useMemo(
    () => messages.some((m) => m.role === 'assistant' && m.created_at > message.created_at),
    [messages, message.created_at],
  )

  if (!message.items?.length || !loaded || list.length === 0 || !answered) return null

  const open = list.filter(isItemOpen)
  const closed = open.length === 0
  const allDone = list.every((item) => item.status === 'done')
  const allDropped = list.every((item) => item.status === 'dropped')
  const closedLabel = allDone ? '完成' : allDropped ? '搁置' : '关闭'

  const close = async (outcome: 'done' | 'dropped') => {
    if (open.length === 0 || saving) return
    setSaving(outcome)
    try {
      await closeItemsRemote(cabinId, open.map((item) => item.id), outcome)
      cabinAudio.blip(outcome === 'done' ? 780 : 520, 0.05)
      toast(outcome === 'done' ? '已关项 · 记录已留' : '已搁置 · 记录已留')
    } catch (err) {
      toast.error(`关项失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div
      className={`ck12-items-rcpt${closed ? ' closed' : ''}`}
      data-testid="cockpit-items-receipt"
      data-open={closed ? 'false' : 'true'}
    >
      <div className="rcpt-h">
        <span className="rh" aria-hidden="true">✦</span>
        <span>回执 · {list.length} 条事项</span>
      </div>
      {list.map((item) => (
        <div key={item.id} className="rcpt-row">
          <span className="ri">#IT-{item.seq}</span>
          <span className="rt" title={item.title}>{item.title.trim() || '（未命名事项）'}</span>
          <span className={`rs ${item.status}`}>{STATUS_LABEL[item.status]}</span>
        </div>
      ))}
      {closed ? (
        <div className="rcpt-done">✓ 已关闭为「{closedLabel}」</div>
      ) : (
        <div className="rcpt-acts">
          <span className="rk">这几条可以关项吗？</span>
          <button
            type="button"
            className="rcpt-btn ok"
            disabled={saving !== null}
            onClick={() => void close('done')}
            data-testid="cockpit-items-receipt-done"
          >
            {saving === 'done' ? '关闭中…' : '✓ 关闭为完成'}
          </button>
          <button
            type="button"
            className="rcpt-btn"
            disabled={saving !== null}
            onClick={() => void close('dropped')}
            data-testid="cockpit-items-receipt-drop"
          >
            搁置
          </button>
        </div>
      )}
    </div>
  )
}
