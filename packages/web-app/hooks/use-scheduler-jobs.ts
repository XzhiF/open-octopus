"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import {
  listJobs,
  toggleJob as apiToggleJob,
  type SchedulerJob,
  type ListJobsParams,
} from "@/lib/scheduler-api"

interface Filters {
  search?: string
  status?: "enabled" | "disabled" | "failed"
  job_type?: "workflow" | "agent"
  workspace_id?: string
  sort?: "next_trigger_at" | "name" | "created_at"
  order?: "asc" | "desc"
}

const DEFAULT_PAGE_SIZE = 20

/**
 * Sync scheduler list filters with URL search params.
 * Refreshing the page preserves filters; URLs can be shared.
 */
function filtersFromSearchParams(sp: URLSearchParams): Filters {
  const f: Filters = {}
  const search = sp.get("search")
  const status = sp.get("status")
  const job_type = sp.get("job_type")
  const workspace_id = sp.get("workspace_id")
  const sort = sp.get("sort")
  const order = sp.get("order")
  if (search) f.search = search
  if (status === "enabled" || status === "disabled" || status === "failed") f.status = status
  if (job_type === "workflow" || job_type === "agent") f.job_type = job_type
  if (workspace_id) f.workspace_id = workspace_id
  if (sort === "next_trigger_at" || sort === "name" || sort === "created_at") f.sort = sort
  if (order === "asc" || order === "desc") f.order = order
  return f
}

function filtersToSearchParams(filters: Filters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.search) sp.set("search", filters.search)
  if (filters.status) sp.set("status", filters.status)
  if (filters.job_type) sp.set("job_type", filters.job_type)
  if (filters.workspace_id) sp.set("workspace_id", filters.workspace_id)
  if (filters.sort) sp.set("sort", filters.sort)
  if (filters.order) sp.set("order", filters.order)
  return sp
}

export function useSchedulerJobs(pageSize = DEFAULT_PAGE_SIZE) {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [jobs, setJobs] = useState<SchedulerJob[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get("page") ?? "1", 10)
    return Number.isFinite(p) && p >= 1 ? p : 1
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Lazy-initialize filters from URL on first mount.
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearchParams(searchParams))
  const abortRef = useRef<AbortController | null>(null)

  const syncFiltersToUrl = useCallback(
    (next: Filters, nextPage?: number) => {
      const sp = filtersToSearchParams(next)
      if (nextPage && nextPage > 1) sp.set("page", String(nextPage))
      const qs = sp.toString()
      router.push(qs ? `/scheduler?${qs}` : "/scheduler", { scroll: false })
    },
    [router]
  )

  const fetchJobs = useCallback(
    async (targetPage?: number) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setLoading(true)
      setError(null)

      try {
        const params: ListJobsParams = {
          page: targetPage ?? page,
          limit: pageSize,
          ...filters,
        }
        const data = await listJobs(params, controller.signal)
        if (controller.signal.aborted) return
        setJobs(data.items)
        setTotal(data.total)
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : "Failed to load jobs")
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    },
    [page, pageSize, filters]
  )

  // Re-fetch when page or filters change
  useEffect(() => {
    fetchJobs()
    return () => {
      abortRef.current?.abort()
    }
  }, [fetchJobs])

  const toggleJobOptimistic = useCallback(
    async (id: string) => {
      // Optimistic update: flip enabled state immediately
      const prev = jobs.find((j) => j.id === id)
      if (!prev) return

      setJobs((current) =>
        current.map((j) =>
          j.id === id ? { ...j, enabled: !j.enabled } : j
        )
      )

      try {
        const updated = await apiToggleJob(id)
        setJobs((current) =>
          current.map((j) => (j.id === id ? updated : j))
        )
      } catch (err: unknown) {
        // Roll back on failure
        setJobs((current) =>
          current.map((j) => (j.id === id ? prev : j))
        )
        throw err
      }
    },
    [jobs]
  )

  const updateFilters = useCallback(
    (next: Partial<Filters>) => {
      setFilters((prev) => {
        const merged = { ...prev, ...next }
        syncFiltersToUrl(merged, 1)
        return merged
      })
      setPage(1)
    },
    [syncFiltersToUrl]
  )

  const clearFilters = useCallback(() => {
    setFilters({})
    syncFiltersToUrl({}, 1)
    setPage(1)
  }, [syncFiltersToUrl])

  // Override setPage to also sync to URL
  const setPageAndSync = useCallback(
    (p: number | ((prev: number) => number)) => {
      setPage((prev) => {
        const next = typeof p === "function" ? p(prev) : p
        syncFiltersToUrl(filters, next)
        return next
      })
    },
    [filters, syncFiltersToUrl]
  )

  return {
    jobs,
    total,
    page,
    setPage: setPageAndSync,
    loading,
    error,
    filters,
    updateFilters,
    clearFilters,
    fetchJobs,
    toggleJob: toggleJobOptimistic,
    refetch: () => fetchJobs(page),
  }
}
