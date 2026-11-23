'use client'

// v20（design 29 §3.2）：线程的数据源 —— 编队行 + 舱主会话 → 线程列表。
// 纯组合 hook：真源仍在 FleetProvider / CockpitStateProvider，这里不另起状态。
//
// v22 #5：主通讯台固定主对话，线程切换（tab / 当前线程 / 关闭）整套撤掉；
// 这里只剩「线程列表 + 按 key 索引 + 主线程」三件事，编队 chat 走独立弹出窗。

import { useMemo } from 'react'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { threadsFromRows, type CockpitThread } from '../fleet/threads-model'

export interface CockpitThreadsView {
  threads: CockpitThread[]
  /** 主线程（threadsFromRows 保证第一条恒为 main）。 */
  active: CockpitThread
  byKey: Map<string, CockpitThread>
}

export function useCockpitThreads(): CockpitThreadsView {
  const { rows, mainSessionId } = useCockpitFleet()

  const threads = useMemo(() => threadsFromRows(rows, mainSessionId), [rows, mainSessionId])
  const byKey = useMemo(() => new Map(threads.map((t) => [t.key, t] as const)), [threads])
  const active = threads[0]

  return { threads, active, byKey }
}
