'use client'

// v21（design 31 §3.2/§3.3）· 右栏容器：待办 chip（上）+ 主菜单（垂直居中）。
//
// answered 是本地乐观集合：在回复卡里答掉、或在主 chat 卡片上答掉（
// octopus:author-ask-answered）都立刻从 chip 计数与列表里消项，不等下一轮轮询。
// attention 里已经消失的 id 会被清出集合，避免无限增长。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitAttentionChip } from './CockpitAttentionChip'
import { CockpitInboxPopover } from './CockpitInboxPopover'
import { CockpitMenuRail } from './CockpitMenuRail'
import { collectInbox, inboxCounts } from './inbox-model'

export function CockpitRightRail() {
  const { rows } = useCockpitFleet()
  const { inboxOpen } = useCockpitState()
  const entries = useMemo(() => collectInbox(rows), [rows])
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())

  const markAnswered = useCallback((id: string) => {
    setAnswered((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  // 主 chat 卡片 / 问答窗答掉：按 ask_id 找到对应 attention 行，同步消项。
  useEffect(() => {
    const onAnswered = (event: Event) => {
      const askId = (event as CustomEvent<{ askMessageId?: string }>).detail?.askMessageId
      if (!askId) return
      setAnswered((prev) => {
        let changed = false
        const next = new Set(prev)
        for (const entry of entries) {
          if (entry.item.ask?.ask_id === askId && !next.has(entry.item.id)) {
            next.add(entry.item.id)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
    window.addEventListener('octopus:author-ask-answered', onAnswered)
    return () => window.removeEventListener('octopus:author-ask-answered', onAnswered)
  }, [entries])

  // 清理已不在 attention 里的 id（每轮轮询后）。
  useEffect(() => {
    const live = new Set(entries.map((entry) => entry.item.id))
    setAnswered((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [entries])

  const counts = useMemo(() => inboxCounts(entries, answered), [entries, answered])

  return (
    <aside className="ck12-rightrail" aria-label="待办与主菜单" data-testid="cockpit-right-rail">
      <CockpitAttentionChip counts={counts} />
      {inboxOpen && (
        <CockpitInboxPopover
          entries={entries}
          counts={counts}
          answered={answered}
          onAnswered={(id) => markAnswered(id)}
        />
      )}
      <CockpitMenuRail />
    </aside>
  )
}
