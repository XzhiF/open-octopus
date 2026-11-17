'use client'

// v20（design 29 §3.2）：线程 tab 的数据源 —— 编队行 + 舱主会话 → 线程列表。
// 纯组合 hook：真源仍在 FleetProvider / CockpitStateProvider，这里不另起状态。

import { useMemo } from 'react'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import {
  threadsFromRows,
  visibleThreads,
  type CockpitThread,
} from '../fleet/threads-model'

export interface CockpitThreadsView {
  threads: CockpitThread[]
  /** tab 条渲染用：主对话 + 未关闭线程。 */
  visible: CockpitThread[]
  active: CockpitThread
  byKey: Map<string, CockpitThread>
}

export function useCockpitThreads(): CockpitThreadsView {
  const { rows, mainSessionId } = useCockpitFleet()
  const { threads: api } = useCockpitState()

  const threads = useMemo(() => threadsFromRows(rows, mainSessionId), [rows, mainSessionId])
  const visible = useMemo(() => visibleThreads(threads, api.closedTabs), [threads, api.closedTabs])
  const byKey = useMemo(() => new Map(threads.map((t) => [t.key, t] as const)), [threads])
  const active = byKey.get(api.activeThread) ?? threads[0]

  return { threads, visible, active, byKey }
}
