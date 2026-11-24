'use client'

// v21（design 31 §3.2/§3.3）· 右栏容器：待办 chip（上）+ 主菜单（垂直居中）。
//
// answered 是本地乐观集合：在回复卡里答掉、或在主 chat 卡片上答掉（
// octopus:author-ask-answered）都立刻从 chip 计数与列表里消项，不等下一轮轮询。
// attention 里已经消失的 id 会被清出集合，避免无限增长。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { nextZ } from '@/components/cabin/z-order'
import { startDecisionKey } from '@/components/cabin/asks/start-window'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitAttentionChip } from './CockpitAttentionChip'
import { CockpitInboxPopover } from './CockpitInboxPopover'
import { CockpitMenuRail } from './CockpitMenuRail'
import { CockpitActivityPopover } from './CockpitActivityPopover'
import { useCockpitActivityFeed } from './activity-feed'
import { collectInbox, inboxCounts } from './inbox-model'

export function CockpitRightRail() {
  const { rows, refetch } = useCockpitFleet()
  const { inboxOpen, activityOpen } = useCockpitState()
  const activity = useCockpitActivityFeed()
  const entries = useMemo(() => collectInbox(rows), [rows])
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())
  /** 待放行：已执行成功的 decision key（同一 attention id 换动作时不能一起藏）。 */
  const [startDecided, setStartDecided] = useState<ReadonlySet<string>>(() => new Set())
  /** 右栏层级（2026-11-24 用户 #1）：主 chat 每次 pointerdown 都会 nextZ() 抬层，
   *  固定 160 的右栏聊上几十轮就被埋 —— 「要我处理」浮层点开却落在主 chat 后面。
   *  浮层开合与右栏内交互都走共享 z 栈：新点开的永远在最上层。 */
  const [z, setZ] = useState<number | null>(null)
  const bumpZ = useCallback(() => setZ(nextZ()), [])
  useEffect(() => {
    if (inboxOpen || activityOpen) bumpZ()
  }, [inboxOpen, activityOpen, bumpZ])

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

  // 待放行的乐观消项键含动作：入列后 attention 同一 id 变成「待触发」时不能被旧键藏住。
  useEffect(() => {
    setStartDecided((prev) => {
      if (prev.size === 0) return prev
      const live = new Set(
        entries
          .filter((entry) => entry.item.stage === 'start')
          .map((entry) => startDecisionKey(entry.item)),
      )
      const next = new Set([...prev].filter((key) => live.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [entries])

  const visible = useMemo(
    () => entries.filter((entry) => !(
      entry.item.stage === 'start' && startDecided.has(startDecisionKey(entry.item))
    )),
    [entries, startDecided],
  )

  const counts = useMemo(() => inboxCounts(visible, answered), [visible, answered])

  const handleStartDecided = useCallback((decisionKey: string) => {
    setStartDecided((prev) => {
      if (prev.has(decisionKey)) return prev
      const next = new Set(prev)
      next.add(decisionKey)
      return next
    })
    void refetch()
  }, [refetch])

  return (
    <aside
      className="ck12-rightrail"
      aria-label="待办与主菜单"
      data-testid="cockpit-right-rail"
      style={z != null ? { zIndex: z } : undefined}
      // 浮层开着时点它（选行 / 切换卡片）→ 再抬一次，别被聚焦的主 chat 反压。
      onPointerDownCapture={() => { if (inboxOpen || activityOpen) bumpZ() }}
    >
      <CockpitAttentionChip counts={counts} />
      {inboxOpen && (
        <CockpitInboxPopover
          entries={visible}
          counts={counts}
          answered={answered}
          onAnswered={(id) => {
            markAnswered(id)
            // 2026-11-19 用户 #9：完成项收下要等服务端 ack 生效，顺手刷一次编队。
            void refetch()
          }}
          onStartDecided={handleStartDecided}
        />
      )}
      {activityOpen && <CockpitActivityPopover />}
      <CockpitMenuRail activityLive={activity.liveCount} />
    </aside>
  )
}
