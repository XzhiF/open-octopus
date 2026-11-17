'use client'

// 立绘互动的最小事件总线：设置面（HUD「◐ 汐音」）里点「互动一下」，由常驻的
// CockpitCrew 执行（气泡 / 表情 / 心形都挂在立绘身上，不在设置面里）。
// 只传「该互动了」这一个信号，不传数据 —— 台词仍由 CockpitCrew 从 XY_LINES 取。

type Listener = () => void

const listeners = new Set<Listener>()

export function requestCrewPoke() {
  for (const listener of listeners) listener()
}

export function subscribeCrewPoke(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试用：清掉残留订阅。 */
export function resetCrewPoke() {
  listeners.clear()
}