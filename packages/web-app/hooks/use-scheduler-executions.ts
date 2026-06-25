"use client"

import { useState, useCallback, useRef } from "react"
import {
  listExecutions,
  type SchedulerExecution,
  type ListExecutionsParams,
} from "@/lib/scheduler-api"

const DEFAULT_PAGE_SIZE = 20

export function useSchedulerExecutions(jobId: string, pageSize = DEFAULT_PAGE_SIZE) {
  const [executions, setExecutions] = useState<SchedulerExecution[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef(false)

  const fetchExecutions = useCallback(
    async (targetPage?: number, statusFilter?: string) => {
      if (!jobId) return
      setLoading(true)
      setError(null)

      try {
        const params: ListExecutionsParams = {
          page: targetPage ?? page,
          limit: pageSize,
        }
        if (statusFilter) params.status = statusFilter

        const data = await listExecutions(jobId, params)
        setExecutions(data.items)
        setTotal(data.total)
        if (targetPage !== undefined) setPage(targetPage)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load executions")
      } finally {
        setLoading(false)
      }
    },
    [jobId, page, pageSize]
  )

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return
    if (executions.length >= total) return

    loadingRef.current = true
    try {
      const nextPage = page + 1
      const data = await listExecutions(jobId, {
        page: nextPage,
        limit: pageSize,
      })
      setExecutions((prev) => [...prev, ...data.items])
      setTotal(data.total)
      setPage(nextPage)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more")
    } finally {
      loadingRef.current = false
    }
  }, [jobId, page, pageSize, executions.length, total])

  return {
    executions,
    total,
    page,
    setPage,
    loading,
    error,
    fetchExecutions,
    loadMore,
    hasMore: executions.length < total,
  }
}
