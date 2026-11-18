'use client'

// 自动回流（原型演练）开关：设置弹窗与 CockpitSim 共用。
// 只在 DEV + ?demo=1 的演示环境实际生效；正常环境开关可见但无副作用。

import { useSyncExternalStore } from 'react'

let auto = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setSimAuto(next: boolean) {
  if (auto === next) return
  auto = next
  emit()
}

export function useSimAuto(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => auto,
    () => false,
  )
}
