'use client'

// S2 owns this file —— S1 先给壳一个诚实的空 Provider 和稳定的 hook 契约。
// S2 接管后内部换成 use-fleet-query 的 10s 轮询（全应用只此一处），
// 但 useCockpitFleet() 的返回形状不变，壳/左栏/舰桥/到达都不需要改。

import { createContext, useContext, type ReactNode } from 'react'
import { useFleetQuery } from './use-fleet-query'
import type { CockpitFleetCounts, CockpitRow } from './fleet-model'

export interface CockpitFleetContextValue {
  rows: CockpitRow[]
  /** null = 还没接上真值。**不是 0** —— HUD 显示「—」，绝不冒充空编队。 */
  counts: CockpitFleetCounts | null
  /** 新增 attention id（S8 简报 + 行 pop 消费）。 */
  arrivals: string[]
  loading: boolean
  error: string | null
  refetch: () => void
}

const EMPTY_FLEET: CockpitFleetContextValue = {
  rows: [],
  counts: null,
  arrivals: [],
  loading: false,
  error: null,
  refetch: () => {},
}

const CockpitFleetContext = createContext<CockpitFleetContextValue>(EMPTY_FLEET)

export function useCockpitFleet(): CockpitFleetContextValue {
  return useContext(CockpitFleetContext)
}

export function CockpitFleetProvider({ children }: { children: ReactNode }) {
  // 全应用唯一一次编队轮询都收在这里；对消费者来说契约完全不变。
  const fleet = useFleetQuery()
  return <CockpitFleetContext.Provider value={fleet}>{children}</CockpitFleetContext.Provider>
}
