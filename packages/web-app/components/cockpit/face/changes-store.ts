'use client'

// 右栏「变更」的开关状态（本舱 cwd 工作区改动窗 · 问题 #1）。
// 与 cabin-tree-store / settings-store 同模式：极小外部 store。
// 窗口需要挂在 CockpitFace 之外 —— 详情面没选中时也要能开。

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setChangesOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function toggleChanges() {
  setChangesOpen(!open)
}

export function useChangesOpen(): boolean {
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
export function resetChanges() {
  open = false
  listeners.clear()
}
