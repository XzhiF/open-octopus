"use client"

import { useState, useEffect, useCallback } from "react"
import { getCostTrends, type CostTrendPoint } from "@/lib/archive-api"

export function useCostTrends(days: number = 7, workspaceId?: string) {
  const [trends, setTrends] = useState<CostTrendPoint[]>([])
  const [summary, setSummary] = useState({ total_cost_usd: 0, avg_daily_cost_usd: 0, max_daily_cost_usd: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refetch = useCallback(() => {
    setLoading(true)
    setError(null)
    getCostTrends(days, workspaceId)
      .then(res => { setTrends(res.trends); setSummary(res.summary) })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [days, workspaceId])

  useEffect(() => { refetch() }, [refetch])

  return { trends, summary, loading, error, refetch }
}
