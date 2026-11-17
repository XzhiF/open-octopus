'use client'

// 单个舱的项目数据（舱籍）：/repos?enrich=1，按 cabinId 缓存 30s + in-flight 去重。
// 失败时保留上一份并标 stale —— 与 use-fleet-query 的容错口径一致：
// 绝不把「接口失败」画成「这个舱没有项目」。

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchCabinRepos, type CabinRepoEntry } from '@/lib/cabin-api'

const TTL_MS = 30_000

interface CacheEntry {
  at: number
  data: CabinRepoEntry[]
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CabinRepoEntry[]>>()
/** 绑定/解绑/开工作树之后通知所有挂着的读数（HUD / 面）重新拉。 */
const listeners = new Map<string, Set<() => void>>()

function loadCabinProjects(cabinId: string, force: boolean): Promise<CabinRepoEntry[]> {
  const hit = cache.get(cabinId)
  if (!force && hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data)
  const running = inflight.get(cabinId)
  if (running) return running
  const next = fetchCabinRepos(cabinId, { enrich: true })
    .then((data) => {
      cache.set(cabinId, { at: Date.now(), data })
      return data
    })
    .finally(() => {
      inflight.delete(cabinId)
    })
  inflight.set(cabinId, next)
  return next
}

/** 绑定/解绑/开工作树之后让缓存失效。 */
export function invalidateCabinProjects(cabinId: string): void {
  cache.delete(cabinId)
  inflight.delete(cabinId)
  for (const notify of [...(listeners.get(cabinId) ?? [])]) notify()
}

export interface CabinProjectsState {
  projects: CabinRepoEntry[]
  loading: boolean
  /** 非 null = 本次刷新失败；projects 仍是上一份（stale）。 */
  error: string | null
  refetch: () => void
}

export function useCabinProjects(cabinId: string | null | undefined): CabinProjectsState {
  const [projects, setProjects] = useState<CabinRepoEntry[]>(() =>
    cabinId ? cache.get(cabinId)?.data ?? [] : [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const aliveRef = useRef(true)

  const refetch = useCallback(() => {
    if (!cabinId) return
    invalidateCabinProjects(cabinId)
    setTick((v) => v + 1)
  }, [cabinId])

  // 订阅失效通知：写操作后同一个 cabin 的所有读数一起重拉。
  useEffect(() => {
    if (!cabinId) return
    const notify = () => setTick((v) => v + 1)
    const set = listeners.get(cabinId) ?? new Set<() => void>()
    set.add(notify)
    listeners.set(cabinId, set)
    return () => {
      set.delete(notify)
      if (set.size === 0) listeners.delete(cabinId)
    }
  }, [cabinId])

  useEffect(() => {
    aliveRef.current = true
    if (!cabinId) {
      setProjects([])
      setLoading(false)
      setError(null)
      return
    }
    const cached = cache.get(cabinId)
    if (cached) setProjects(cached.data)
    setLoading(!cached)
    setError(null)
    loadCabinProjects(cabinId, tick > 0)
      .then((data) => {
        if (!aliveRef.current) return
        setProjects(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false)
      })
    return () => {
      aliveRef.current = false
    }
  }, [cabinId, tick])

  return { projects, loading, error, refetch }
}