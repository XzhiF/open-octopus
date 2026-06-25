"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import type { ScheduleExecution } from "@/lib/types"
import * as api from "@/lib/schedule-api"

const POLL_INTERVAL = 10_000

export function useScheduleExecutions(
  wsId: string,
  scheduleId: string,
  pageSize = 20
) {
  const [executions, setExecutions] = useState<ScheduleExecution[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!wsId || !scheduleId) return
    try {
      const data = await api.listScheduleExecutions(wsId, scheduleId, {
        page,
        pageSize,
      })
      setExecutions(data.items)
      setTotal(data.total)
    } catch {
      // Silently fail on poll — keep previous data
    } finally {
      setLoading(false)
    }
  }, [wsId, scheduleId, page, pageSize])

  // Initial load + page change
  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  // 10s polling for live updates
  useEffect(() => {
    timerRef.current = setInterval(refresh, POLL_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  const retry = useCallback(
    async (executionId: string) => {
      const retried = await api.retryScheduleExecution(wsId, scheduleId, executionId)
      setExecutions((prev) => [retried, ...prev])
      return retried
    },
    [wsId, scheduleId]
  )

  return { executions, total, page, setPage, loading, refresh, retry }
}
