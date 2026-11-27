'use client'

// v22（2026-11-27 用户）：独立 chat 窗的焦点态 —— 原型 .cwin.focus 的加粗光晕。
//
// z 栈（cabin/z-order）只存数字、且每个窗各自持有；「谁是当前置顶窗」需要一份
// 共享可订阅的最小状态，于是单独放这里。'main' 表示主通讯台在顶（所有独立窗
// 失去焦点环）；null 表示没有置顶窗（全收起后）。
//
// 只影响视觉：点击顺序仍由 nextZ() 决定。

import { useSyncExternalStore } from 'react'

export type ActiveWin = string | null

let active: ActiveWin = null
const listeners = new Set<() => void>()

export function setActiveWin(id: ActiveWin) {
  if (active === id) return
  active = id
  for (const listener of listeners) listener()
}

export function useActiveWin(): ActiveWin {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => active,
    () => null,
  )
}

/** 测试用：清空状态与订阅。 */
export function resetActiveWinForTest(): void {
  active = null
  listeners.clear()
}
