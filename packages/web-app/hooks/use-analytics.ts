"use client"

import { useState, useEffect, useCallback, useRef } from "react"

export function useAnalytics<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = []
) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // R2-H-5: 统一使用 ref 管理 AbortController，初始请求和 refresh 共享
  // 这样 refresh() 可以取消正在进行的初始请求，避免竞态
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()
    setLoading(true)
    setError(null)
    fetcher(controllerRef.current.signal)
      .then(d => {
        if (!controllerRef.current?.signal.aborted) setData(d)
      })
      .catch(e => {
        if (e.name !== "AbortError") setError(e.message)
      })
      .finally(() => {
        if (!controllerRef.current?.signal.aborted) setLoading(false)
      })
    return () => controllerRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const refresh = useCallback(() => {
    // 取消上一次请求（无论是初始请求还是上一次 refresh）
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()
    setLoading(true)
    setError(null)
    return fetcher(controllerRef.current.signal)
      .then(d => {
        if (!controllerRef.current?.signal.aborted) setData(d)
      })
      .catch(e => {
        if (e.name !== "AbortError") setError(e.message)
      })
      .finally(() => {
        if (!controllerRef.current?.signal.aborted) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // 组件卸载时统一取消
  useEffect(() => {
    return () => controllerRef.current?.abort()
  }, [])

  return { data, loading, error, refresh }
}
