'use client'

// 事项投递排队条（2026-11-24 用户）：主对话在跑时，投递先候着 ——
// 贴在通讯台输入行上方；当前一轮收口后自动送达（与原型 ⏳ 排队 条一一对应）。
//
// 真正发消息走 chat.submit(text, { via:'items', itemIds })，与直接投递同一条管线；
// 出队时合并同一舱的多条投递成一条消息，避免连发。

import { useEffect, useMemo, useRef } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import {
  cancelDeliveryQueue, loadCabinItems, markDeliveredLocal,
  takeDeliveryQueue, useItemDeliveryQueue,
} from './items-store'

export function CockpitItemsQueue() {
  const { entryCabinId, chat } = useCockpitState()
  const all = useItemDeliveryQueue()
  const mine = useMemo(
    () => all.filter((entry) => entry.cabinId === entryCabinId),
    [all, entryCabinId],
  )
  const streaming = chat?.streaming ?? false
  const wasStreamingRef = useRef(streaming)

  useEffect(() => {
    const was = wasStreamingRef.current
    wasStreamingRef.current = streaming
    if (!chat || streaming || !was || mine.length === 0) return
    const timer = window.setTimeout(() => {
      const take = takeDeliveryQueue(entryCabinId)
      if (take.length === 0 || !chat) return
      const ids = Array.from(new Set(take.flatMap((entry) => entry.itemIds)))
      const text = take.map((entry) => entry.text).join('\n\n')
      markDeliveredLocal(entryCabinId, ids)
      chat.submit(text, { via: 'items', itemIds: ids })
      window.setTimeout(() => { void loadCabinItems(entryCabinId, true) }, 1500)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [streaming, chat, entryCabinId, mine.length])

  if (mine.length === 0) return null
  const chips = Array.from(new Set(mine.flatMap((entry) => entry.labels)))

  return (
    <div className="ck12-items-queue" data-testid="cockpit-items-queue" role="status" aria-live="polite">
      <span className="qi">
        <b>⏳ 排队 {mine.length}</b>
        {' · '}事项 {chips.join(' ')} · 主对话当前一轮结束后自动送达
      </span>
      <span className="sp" />
      <button
        type="button"
        onClick={() => cancelDeliveryQueue()}
        title="撤回本舱所有排队投递"
      >
        撤回
      </button>
    </div>
  )
}
