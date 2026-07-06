"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import {
  listResources,
  getResource,
  getResourceDeps,
  listAudit,
  type RegistryEntry,
  type ResourceType,
  type DepNode,
  type AuditEntry,
  type ListResourcesParams,
  type ListAuditParams,
} from "@/lib/resource/api"

// ── URL sync helpers ──

function paramsFromSearch(sp: URLSearchParams): ListResourcesParams {
  const p: ListResourcesParams = {}
  const type = sp.get("type")
  if (type === "skill" || type === "agent" || type === "workflow") p.type = type
  const q = sp.get("q")
  if (q) p.query = q
  return p
}

function paramsToSearch(params: ListResourcesParams): URLSearchParams {
  const sp = new URLSearchParams()
  if (params.type) sp.set("type", params.type)
  if (params.query) sp.set("q", params.query)
  return sp
}

// ── useResources ──

export function useResources() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [data, setData] = useState<RegistryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const filters = paramsFromSearch(searchParams)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listResources(filters)
      setData(res.data)
      setTotal(res.meta.total)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [filters.type, filters.query])

  useEffect(() => { fetchData() }, [fetchData])

  const setTypeFilter = useCallback((type: ResourceType | undefined) => {
    const sp = paramsToSearch({ ...filters, type })
    router.push(`/resources?${sp.toString()}`, { scroll: false })
  }, [filters, router])

  const setQuery = useCallback((query: string) => {
    const sp = paramsToSearch({ ...filters, query: query || undefined })
    router.push(`/resources?${sp.toString()}`, { scroll: false })
  }, [filters, router])

  return {
    data,
    total,
    loading,
    error,
    refetch: fetchData,
    type: filters.type,
    query: filters.query ?? "",
    setTypeFilter,
    setQuery,
  }
}

// ── useResourceDetail ──

export function useResourceDetail(type: ResourceType, name: string) {
  const [resource, setResource] = useState<RegistryEntry | null>(null)
  const [deps, setDeps] = useState<{ forward: DepNode[]; reverse: DepNode[] }>({ forward: [], reverse: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [resRes, depsRes] = await Promise.all([
        getResource(type, name),
        getResourceDeps(type, name),
      ])
      setResource(resRes.data)
      setDeps(depsRes.data)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [type, name])

  useEffect(() => { fetchDetail() }, [fetchDetail])

  return { resource, deps, loading, error, refetch: fetchDetail }
}

// ── useAuditLog ──

export function useAuditLog(filter?: ListAuditParams) {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const action = searchParams.get("action") ?? filter?.action
  const resource = searchParams.get("resource") ?? filter?.resource
  const last = Number(searchParams.get("last") ?? filter?.last ?? 50)

  const fetchAudit = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listAudit({ last, action, resource })
      setEntries(res.data)
      setTotal(res.meta.total)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [last, action, resource])

  useEffect(() => { fetchAudit() }, [fetchAudit])

  const setActionFilter = useCallback((a: string | undefined) => {
    const sp = new URLSearchParams(searchParams.toString())
    if (a) sp.set("action", a)
    else sp.delete("action")
    router.push(`/resources/audit?${sp.toString()}`, { scroll: false })
  }, [searchParams, router])

  return { entries, total, loading, error, refetch: fetchAudit, action, setActionFilter }
}

// ── useDebounce ──

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}
