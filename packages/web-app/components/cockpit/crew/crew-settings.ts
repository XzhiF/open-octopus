'use client'

// 汐音设置面的开关状态（HUD 上的「◐ 汐音」与 ⌥X 共用）。
//
// 不塞进 CockpitState：它只是 HUD 的一个本地浮层，跟 selection / chat / fx 无关；
// 但快捷键在另一棵树里（CockpitShortcuts），所以用一个极小的外部 store。

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setCrewSettingsOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function toggleCrewSettings() {
  setCrewSettingsOpen(!open)
}

export function isCrewSettingsOpen(): boolean {
  return open
}

export function useCrewSettingsOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => open,
    () => false,
  )
}

/** 测试用：清空状态与订阅。 */
export function resetCrewSettings() {
  open = false
  listeners.clear()
}