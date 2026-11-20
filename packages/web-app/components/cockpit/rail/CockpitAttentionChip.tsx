'use client'

// v21（design 31 §3.2.1）· 右栏顶部「要我处理」紧凑 chip。
// 只显示图标 + 标题 + 总数；明细计数收进浮层头部（给主 chat 让位）。
// 零待办转灰；新回传 ping 1s；点击开合 inbox 浮层。

import { useEffect, useRef, useState } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import type { InboxCounts } from './inbox-model'

export function CockpitAttentionChip({ counts }: { counts: InboxCounts }) {
  const { inboxOpen, openInbox, closeInbox } = useCockpitState()
  const { arrivals } = useCockpitFleet()
  const [ping, setPing] = useState(0)
  const seenRef = useRef<string>('')

  // 新回传：arrivals 变化时 chip 外扩 16px 一圈（原型 chipPing 1s）。
  useEffect(() => {
    if (arrivals.length === 0) {
      seenRef.current = ''
      return
    }
    const signature = arrivals.join('|')
    if (signature === seenRef.current) return
    seenRef.current = signature
    setPing((n) => n + 1)
  }, [arrivals])

  const zero = counts.total === 0

  return (
    <button
      type="button"
      key={ping}
      className={`ck12-inboxchip${zero ? ' is-zero' : ''}${inboxOpen ? ' is-on' : ''}${ping > 0 ? ' is-ping' : ''}`}
      data-testid="cockpit-inbox-chip"
      aria-expanded={inboxOpen}
      aria-label={zero ? '要我处理 · 暂无待办' : `要我处理 ${counts.total} 条`}
      title={zero ? '要我处理 · 暂无待办' : `要我处理 · 待你定 ${counts.ask} · 验收 ${counts.rev} · 受阻 ${counts.blk} · 完成 ${counts.done}`}
      onClick={() => (inboxOpen ? closeInbox() : openInbox(null))}
    >
      <span className="ck12-inboxchip-ic" aria-hidden="true">✉</span>
      <span className="ck12-inboxchip-t">
        要我处理
        {!zero && <i className="ck12-inboxchip-dot" aria-hidden="true" />}
      </span>
      <span className="ck12-inboxchip-n" data-testid="cockpit-inbox-count">{counts.total}</span>
    </button>
  )
}
