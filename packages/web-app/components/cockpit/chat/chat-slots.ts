'use client'

// S5 owns this file —— 壳里三个兄弟节点之间交换 DOM 挂载点。
//
// CockpitShell 里 `CockpitChatHost` / `CockpitChatWindow` 是**平级**的兄弟。
// Host 拿不到 Window 的 ref，所以用模块级 registry：
//   · Window 注册 transcript 挂载点（ChatPane 的转录区 portal 进去）；
//   · Window 注册 index 挂载点（标题栏的「对话索引」，ChatTimeline portal 进去）；
//   · v21 三轮：composer 槽也由 Window 注册（原型 .con-in，通讯台内）；
//   · v22 十轮：attach 槽由 Window 注册（头部「星核」钮，ChatArea 的挂载
//     面板 portal 进去 —— 技能 / 分身 / MCP 的入口从输入行搬到台头）。
//
// 用 useSyncExternalStore：注册/注销在 commit 阶段发生，消费方安全重渲染。
// 槽节点在 Window 的整个生命周期内保持同一个 DOM 节点（关窗只切
// `display:none`），所以 ChatPane 不会因为开/关窗被卸载。

import { useSyncExternalStore } from 'react'

export type ChatSlotKind = 'transcript' | 'composer' | 'index' | 'attach'

const slots: Record<ChatSlotKind, HTMLElement | null> = {
  transcript: null,
  composer: null,
  index: null,
  attach: null,
}

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** 注册/注销一个槽；同一 kind 以最后一次注册为准。 */
export function setChatSlot(kind: ChatSlotKind, node: HTMLElement | null) {
  if (slots[kind] === node) return
  slots[kind] = node
  emit()
}

export function getChatSlot(kind: ChatSlotKind): HTMLElement | null {
  return slots[kind]
}

/** 测试与整页卸载用：清空全部槽。 */
export function resetChatSlots() {
  slots.transcript = null
  slots.composer = null
  slots.index = null
  slots.attach = null
  emit()
}

export function subscribeChatSlots(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useChatSlot(kind: ChatSlotKind): HTMLElement | null {
  return useSyncExternalStore(
    subscribeChatSlots,
    () => slots[kind],
    () => null,
  )
}
