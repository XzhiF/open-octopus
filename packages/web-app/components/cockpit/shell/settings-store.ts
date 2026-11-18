'use client'

// 舱内设置弹窗的开关状态（「更多 → 设置」打开）。
// 与 crew-settings 同模式：极小外部 store，不塞进 CockpitState。

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setCockpitSettingsOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function toggleCockpitSettings() {
  setCockpitSettingsOpen(!open)
}

export function useCockpitSettingsOpen(): boolean {
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
export function resetCockpitSettings() {
  open = false
  listeners.clear()
}
