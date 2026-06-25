"use client"

import { useState, useCallback } from "react"
import {
  getDashboard,
  type DashboardSummary,
  type DashboardParams,
} from "@/lib/scheduler-api"

export function useSchedulerDashboard() {
  const [data, setData] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchDashboard = useCallback(async (params?: DashboardParams) => {
    setLoading(true)
    setError(null)
    try {
      const result = await getDashboard(params)
      setData(result)
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load dashboard"
      setError(msg)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  return { data, loading, error, fetchDashboard }
}
