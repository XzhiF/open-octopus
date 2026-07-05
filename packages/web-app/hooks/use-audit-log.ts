import { useState, useEffect, useCallback } from "react"
import { resourceApi } from "@/lib/api-client"
import type { AuditEntry } from "@/lib/types"

interface UseAuditLogFilters {
  action?: string
  resource?: string
  last?: number
}

interface UseAuditLogReturn {
  entries: AuditEntry[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useAuditLog(filters: UseAuditLogFilters = {}): UseAuditLogReturn {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAuditLog = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await resourceApi.audit({
        action: filters.action || undefined,
        resource: filters.resource || undefined,
        last: filters.last || 20,
      })
      setEntries(data.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载审计日志失败")
    } finally {
      setLoading(false)
    }
  }, [filters.action, filters.resource, filters.last])

  useEffect(() => {
    fetchAuditLog()
  }, [fetchAuditLog])

  return { entries, loading, error, refetch: fetchAuditLog }
}
