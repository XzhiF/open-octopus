'use client'

// 右栏「目录」的开关状态（本舱 cwd 只读目录窗）。
// 与 settings-store 同模式：极小外部 store，不塞进 CockpitState。
// 窗口需要挂在 CockpitFace 之外 —— 详情面没选中时也要能开。

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setCabinTreeOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function toggleCabinTree() {
  setCabinTreeOpen(!open)
}

export function useCabinTreeOpen(): boolean {
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
export function resetCabinTree() {
  open = false
  listeners.clear()
}
