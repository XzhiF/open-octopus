"use client"

import { useState, useEffect, useCallback } from "react"
import { getAuditLog } from "@/lib/resource/api"
import type { ResourceAuditRecord } from "@/lib/resource/types"

interface UseAuditLogOptions {
  last?: number
  action?: string
}

interface UseAuditLogResult {
  records: ResourceAuditRecord[]
  total: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useAuditLog(options?: UseAuditLogOptions): UseAuditLogResult {
  const [records, setRecords] = useState<ResourceAuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getAuditLog({
        last: options?.last,
        action: options?.action === "all" ? undefined : options?.action,
      })
      setRecords(res.records)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log")
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [options?.last, options?.action])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { records, total, loading, error, refresh }
}
