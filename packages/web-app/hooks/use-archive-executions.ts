"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { getArchiveExecutions, type ArchiveExecution, type PaginatedResult } from "@/lib/archive-api"

interface ExecutionsOpts {
  page?: number; pageSize?: number; workflow?: string; status?: string;
  from?: string; to?: string; sort?: string; order?: string
}

export function useArchiveExecutions(opts: ExecutionsOpts = {}) {
  const [data, setData] = useState<PaginatedResult<ArchiveExecution>>({ data: [], total: 0, page: 1, pageSize: 20 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refetch = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    getArchiveExecutions(opts)
      .then(setData)
      .catch(err => { if (err.name !== "AbortError") setError(err) })
      .finally(() => setLoading(false))
  }, [opts.page, opts.pageSize, opts.workflow, opts.status, opts.from, opts.to, opts.sort, opts.order])

  useEffect(() => { refetch() }, [refetch])

  return { data, loading, error, refetch }
}
