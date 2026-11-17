'use client'

// S6 · 本舱用量（¥ 读数 + 上下文弹层里的「本舱按主体」）。
//
// 唯一来源：GET /api/cabins/:id/usage（lib/cabin-api.getCabinUsage）。
// 30s 轮询；失败**保留上一份快照**，只把 stale 置真（UI 在 title 里说明），
// 绝不把成本清成 0 或 `--`。卸载 / 换舱后不再写 state。

import { useEffect, useRef, useState } from 'react'
import { getCabinUsage, type CabinUsagePayload } from '@/lib/cabin-api'

export interface CabinUsageState {
  usage: CabinUsagePayload | null
  /** 最近一次拉取失败（仍显示上一次成功值）。 */
  stale: boolean
}

export const CABIN_USAGE_INTERVAL_MS = 30_000

export function useCabinUsage(
  cabinId: string,
  intervalMs: number = CABIN_USAGE_INTERVAL_MS,
): CabinUsageState {
  const [usage, setUsage] = useState<CabinUsagePayload | null>(null)
  const [stale, setStale] = useState(false)
  const cabinRef = useRef(cabinId)

  useEffect(() => {
    let alive = true
    const sameCabin = cabinRef.current === cabinId
    cabinRef.current = cabinId
    if (!sameCabin) {
      // 换舱：上一间舱的账不能挂在新舱上（壳通常已 key 重挂，这里再兜一层）。
      setUsage(null)
      setStale(false)
    }

    const load = async () => {
      try {
        const next = await getCabinUsage(cabinId)
        if (!alive) return
        setUsage(next)
        setStale(false)
      } catch {
        if (!alive) return
        // 保留上一次成功值；没有成功值就显示「—」由调用方决定。
        setStale(true)
      }
    }

    void load()
    const timer = window.setInterval(() => { void load() }, intervalMs)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [cabinId, intervalMs])

  return { usage, stale }
}
