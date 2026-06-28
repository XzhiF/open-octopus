"use client"

import { useState, useEffect, useCallback } from "react"
import { getArchiveStats, type ArchiveStats } from "@/lib/archive-api"

export function useArchiveStats() {
  const [data, setData] = useState<ArchiveStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refetch = useCallback(() => {
    setLoading(true)
    setError(null)
    getArchiveStats()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refetch() }, [refetch])

  return { data, loading, error, refetch }
}
