"use client"

import { useState, useEffect, useCallback } from "react"
import { listResources } from "@/lib/resource/api"
import type { ResourceEntry, ListQuery } from "@/lib/resource/types"

interface UseResourceListResult {
  resources: ResourceEntry[]
  total: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useResourceList(query?: ListQuery): UseResourceListResult {
  const [resources, setResources] = useState<ResourceEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listResources(query)
      setResources(res.resources)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load resources")
      setResources([])
    } finally {
      setLoading(false)
    }
  }, [query?.type, query?.query, query?.installed])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { resources, total, loading, error, refresh }
}
