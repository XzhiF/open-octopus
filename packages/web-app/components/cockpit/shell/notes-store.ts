'use client'

// 全舱便签窗的开关状态（HUD 右上角「✎ 便签」开合）。
// 与 settings-store 同模式：极小外部 store，不塞进 CockpitState。
//
// 便签内容本身不在这里 —— 走 lib/quick-notes 的 localStorage 数据层
// （octopus.quick-notes.v1），与 classic 快速便签是同一份。

import { useSyncExternalStore } from 'react'
import { getQuickNotes, subscribeQuickNotes } from '@/lib/quick-notes'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setCockpitNotesOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function toggleCockpitNotes() {
  setCockpitNotesOpen(!open)
}

export function useCockpitNotesOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => open,
    () => false,
  )
}

/** HUD 徽标：只订阅条数，内容编辑不重渲染抬头条。 */
export function useQuickNoteCount(): number {
  return useSyncExternalStore(
    subscribeQuickNotes,
    () => getQuickNotes().length,
    () => 0,
  )
}

/** 测试用：清空状态与订阅。 */
export function resetCockpitNotesForTests() {
  open = false
  listeners.clear()
}
