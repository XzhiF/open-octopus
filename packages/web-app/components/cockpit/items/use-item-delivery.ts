'use client'

// 事项 → 主对话的投递能力（2026-11-24 用户）。
//
// 两条路径：
//   deliver = 直接投递（主对话空闲时立即发；在跑时进舱内排队条，本轮收口后自动送）
//   stage   = 带到输入框（预填文案 + 挂件；人改完发出去才算交付）
//
// 真正的「交付」由服务端在 chat 路由里落库（user message metadata via='items' +
// 事项 todo → delivered）；这里只做乐观标记与排队。

import { useCallback } from 'react'
import type { CabinItemDTO } from '@octopus/shared'
import { useCockpitState } from '../state/CockpitStateProvider'
import {
  enqueueDelivery, isItemOpen, itemDeliveryText, itemLabel,
  loadCabinItems, markDeliveredLocal, useItemDeliveryQueue,
} from './items-store'

export interface DeliverResult {
  ok: boolean
  /** true = 主对话在跑，已进排队条。 */
  queued?: boolean
  /** 排队位次（1 起）。 */
  position?: number
  reason?: 'no-chat' | 'empty'
}

export function useItemDelivery(cabinId: string) {
  const { chat, chatWindow } = useCockpitState()
  const queue = useItemDeliveryQueue()
  const queuedCount = queue.filter((entry) => entry.cabinId === cabinId).length

  const deliver = useCallback((items: CabinItemDTO[]): DeliverResult => {
    const list = items.filter(isItemOpen)
    if (list.length === 0) return { ok: false, reason: 'empty' }
    if (!chat) return { ok: false, reason: 'no-chat' }
    chatWindow.openWithFocus()
    if (chat.streaming) {
      enqueueDelivery({
        cabinId,
        itemIds: list.map((item) => item.id),
        labels: list.map(itemLabel),
        text: itemDeliveryText(list),
      })
      return { ok: true, queued: true, position: queuedCount + 1 }
    }
    const ids = list.map((item) => item.id)
    markDeliveredLocal(cabinId, ids)
    chat.submit(itemDeliveryText(list), { via: 'items', itemIds: ids })
    // 服务端在 chat 路由里落 delivered；稍后对齐一次，拿到真实时间戳。
    window.setTimeout(() => { void loadCabinItems(cabinId, true) }, 1500)
    return { ok: true, queued: false }
  }, [cabinId, chat, chatWindow, queuedCount])

  const stage = useCallback((items: CabinItemDTO[]): boolean => {
    const list = items.filter(isItemOpen)
    if (list.length === 0 || !chat) return false
    chatWindow.openWithFocus()
    chat.seed(itemDeliveryText(list), {
      via: 'items',
      itemIds: list.map((item) => item.id),
      labels: list.map(itemLabel),
    })
    return true
  }, [chat, chatWindow])

  return { deliver, stage, queuedCount, chatReady: !!chat }
}
