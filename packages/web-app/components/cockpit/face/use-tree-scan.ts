'use client'

// 目录树数据源（2026-11-24 目录窗优化）· 本舱 cwd / 项目 worktree 三处界面共用：
//   · 首次载入 / 换根 = reset（generation +1，消费方据此重置展开 / 选中 / 标签页）；
//   · 之后的刷新一律静默：只换 entries，不动 UI 状态；
//   · 刷新触发：cabin SSE `tree_changed`（服务端 chokidar，即时）+ 30s 兜底轮询 +
//     窗口重新可见 / 聚焦（≥5s 才补一次）；
//   · 服务端有 10s TTL 缓存 + in-flight 去重，三处同时打开同一棵树只扫一次磁盘。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getCabinTree, getRepoTree, subscribeTreeChanges,
  type RepoTreeEntry, type TreeScanResult,
} from '@/lib/cabin-api'

/** 兜底轮询：SSE 断线 / 老浏览器时也能在 30s 内看到新文件；同时续租服务端 watcher。 */
const POLL_MS = 30_000
/** 聚焦补拉的最小间隔：太近的重复请求交给服务端缓存。 */
const FOCUS_MIN_GAP_MS = 5_000

export interface UseTreeScanParams {
  cabinId: string
  /** null = 本舱 cwd（右栏「目录」）；否则看该项目的 worktree。 */
  repoName: string | null
  /** false = 不请求（项目还没对上舱籍条目）。 */
  enabled?: boolean
}

export interface TreeScanState {
  entries: RepoTreeEntry[] | null
  dir: string
  /** 命中深度 / 条目上限，树不完整。 */
  truncated: boolean
  truncReason: 'depth' | 'count' | null
  maxDepth: number | null
  loading: boolean
  error: string | null
  /** 首次载入 / 换根后 +1；静默刷新不变。 */
  generation: number
  /** 手动重扫（↻）：fresh = 绕过服务端缓存；默认静默，不重置 UI 状态。 */
  reload: (opts?: { fresh?: boolean }) => void
}

export function useTreeScan({ cabinId, repoName, enabled = true }: UseTreeScanParams): TreeScanState {
  const isCabin = repoName == null
  const active = enabled

  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null)
  const [dir, setDir] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [truncReason, setTruncReason] = useState<'depth' | 'count' | null>(null)
  const [maxDepth, setMaxDepth] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  const [tick, setTick] = useState(0)
  const requestRef = useRef<{ fresh: boolean }>({ fresh: false })
  const scopeRef = useRef<string | null>(null)
  const hasDataRef = useRef(false)
  const loadedAtRef = useRef(0)

  const reload = useCallback((opts?: { fresh?: boolean }) => {
    requestRef.current = { fresh: opts?.fresh === true }
    setTick((value) => value + 1)
  }, [])

  const scopeKey = `${cabinId}|${repoName ?? ''}|${active ? '1' : '0'}`

  useEffect(() => {
    if (!active) return
    const reset = scopeRef.current !== scopeKey
    scopeRef.current = scopeKey
    const fresh = requestRef.current.fresh
    requestRef.current = { fresh: false }

    let alive = true
    // reset 之外的「第一次成功载入」也要让消费方初始化（首轮请求可能被更快的静默刷新顶掉）。
    const firstLoad = !hasDataRef.current
    if (reset) {
      hasDataRef.current = false
      setEntries(null)
      setDir('')
      setTruncated(false)
      setTruncReason(null)
      setMaxDepth(null)
      setError(null)
    }
    if (reset || !hasDataRef.current) setLoading(true)

    // 不 fresh 时不传第三参（调用方 spy / 测试按 (cabinId, repo) 断言更干净）。
    const request = isCabin
      ? (fresh ? getCabinTree(cabinId, { fresh: true }) : getCabinTree(cabinId))
      : (fresh
          ? getRepoTree(cabinId, repoName as string, { fresh: true })
          : getRepoTree(cabinId, repoName as string))
    request
      .then((res: TreeScanResult) => {
        if (!alive) return
        hasDataRef.current = true
        loadedAtRef.current = Date.now()
        setEntries(res.entries)
        setDir(res.dir)
        setTruncated(res.truncated === true)
        setTruncReason(res.reason ?? null)
        setMaxDepth(res.maxDepth ?? null)
        setError(null)
        if (reset || firstLoad) setGeneration((value) => value + 1)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : '读取目录失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [active, cabinId, isCabin, repoName, scopeKey, tick])

  // 增量刷新：SSE 即时 + 30s 兜底 + 聚焦/可见补拉（都走静默载入）。
  useEffect(() => {
    if (!active || !dir) return
    const off = subscribeTreeChanges(cabinId, dir, () => reload())

    const maybeReload = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (Date.now() - loadedAtRef.current < FOCUS_MIN_GAP_MS) return
      reload()
    }
    const poll = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      reload()
    }, POLL_MS)
    window.addEventListener('focus', maybeReload)
    document.addEventListener('visibilitychange', maybeReload)
    return () => {
      off()
      window.clearInterval(poll)
      window.removeEventListener('focus', maybeReload)
      document.removeEventListener('visibilitychange', maybeReload)
    }
  }, [active, cabinId, dir, reload])

  return {
    entries, dir, truncated, truncReason, maxDepth, loading, error, generation, reload,
  }
}
