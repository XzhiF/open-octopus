'use client'

// 「更多 → 活动日志」大窗的开关状态（2026-11-24 用户 #1）。
// 与 cabin-tree-store 同模式：极小外部 store，不塞进 CockpitState ——
// 窗口挂在 Shell 层，右栏「更多」只管开合。

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setActivityLogOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function toggleActivityLog() {
  setActivityLogOpen(!open)
}

export function useActivityLogOpen(): boolean {
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
export function resetActivityLog(): void {
  open = false
  listeners.clear()
}
