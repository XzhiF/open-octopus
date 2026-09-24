// packages/web-app/components/tasks/authoring/use-home-tree.ts
//
// 输出区磁盘直扫（2026-09-24 拍板：「完整路径 + 任务 home 目录如实显示」）：
// 数据源 = GET /:id/home-tree —— 任务 home（~/.octopus/tasks/<id>）的原始目录
// 列表，文件系统即真相（空目录也在列），不做产物/批次语义。刷新通路沿用
// use-batch-tree 的五路纪律；R1 不再限路径标记 —— agent 会话 cwd 就是 home，
// 任何已完成的写工具调用都值得重扫一次。

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getHomeTree, type HomeTreeEntry } from "@/lib/tasks-api"
import type { ToolCallRecord } from "@/lib/agent/types"
import {
  DONE_STATUSES,
  R1_DEBOUNCE_MS,
  RETRY_DELAY_MS,
  WRITE_TOOLS,
} from "./use-batch-tree"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"

export interface HomeTreeState {
  /** 任务 home 绝对路径（树头展示；首载前 null）。 */
  dir: string | null
  entries: HomeTreeEntry[]
  loading: boolean
  error: string | null
  refresh: () => void
}

export interface UseHomeTreeOptions {
  toolCalls?: ToolCallRecord[]
  streaming?: boolean
  versionKey?: number
}

function isHomeWrite(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

export function useHomeTree(taskId: string, opts: UseHomeTreeOptions = {}): HomeTreeState {
  const { toolCalls, streaming, versionKey } = opts
  const [dir, setDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<HomeTreeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const seqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const doFetch = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      let tree: { dir: string; entries: HomeTreeEntry[] }
      try {
        tree = await getHomeTree(taskId)
      } catch {
        // 连接层瞬时失败 —— 500ms 静默重试一次（与 batch-tree 同自愈口径）。
        if (!mountedRef.current || seq !== seqRef.current) return
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        if (!mountedRef.current || seq !== seqRef.current) return
        tree = await getHomeTree(taskId)
      }
      if (!mountedRef.current || seq !== seqRef.current) return
      setDir(tree.dir)
      setEntries(tree.entries)
      setError(null)
    } catch (err: unknown) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : "目录树加载失败")
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [taskId])

  const refresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    void doFetch()
  }, [doFetch])

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void doFetch()
    }, R1_DEBOUNCE_MS)
  }, [doFetch])

  // ① mount / taskId — reset + fetch.
  useEffect(() => {
    setDir(null)
    setEntries([])
    setError(null)
    setLoading(true)
    void doFetch()
  }, [doFetch])

  // ② version bumps (skip the initial render — ① already fetched).
  const firstVersionRef = useRef(true)
  useEffect(() => {
    if (firstVersionRef.current) {
      firstVersionRef.current = false
      return
    }
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on version change only
  }, [versionKey])

  // ③ R1: any completed write tool call (agent cwd = home) → debounced re-scan.
  const processedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!toolCalls) return
    let hit = false
    for (const tc of toolCalls) {
      if (processedRef.current.has(tc.id)) continue
      if (DONE_STATUSES.has(String(tc.status)) && isHomeWrite(tc.name)) {
        processedRef.current.add(tc.id)
        hit = true
      }
    }
    if (hit) scheduleRefresh()
  }, [toolCalls, scheduleRefresh])

  // ④ streaming true→false (turn ended) — fallback for writes R1 can't see.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    const now = !!streaming
    if (wasStreamingRef.current && !now) refresh()
    wasStreamingRef.current = now
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge detection only
  }, [streaming])

  // ⑤ task_artifacts_update（执行期 seed/collect、home-file PUT 都会发）。
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      TASK_ARTIFACTS_UPDATE_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { task_id?: string }
          if (payload.task_id !== taskId) return
          scheduleRefresh()
        } catch {
          // malformed payload — ignore (defensive)
        }
      },
    )
    return () => unsub()
  }, [taskId, scheduleRefresh])

  return { dir, entries, loading, error, refresh }
}
