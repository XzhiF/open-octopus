import { useState, useEffect, useCallback } from "react"
import { resourceApi } from "@/lib/api-client"
import type { Resource } from "@/lib/types"

interface UseResourcesOptions {
  type?: string
  query?: string
}

interface UseResourcesReturn {
  resources: Resource[]
  loading: boolean
  error: string | null
  refetch: () => void
  counts: { all: number; skill: number; agent: number; workflow: number; source: number }
}

export function useResources(options: UseResourcesOptions = {}): UseResourcesReturn {
  const { type, query } = options
  const [resources, setResources] = useState<Resource[]>([])
  const [allResources, setAllResources] = useState<Resource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchResources = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await resourceApi.list()
      setAllResources(data.resources)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载资源失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchResources()
  }, [fetchResources])

  // Client-side filtering
  useEffect(() => {
    let filtered = allResources

    if (type && type !== "all") {
      filtered = filtered.filter(r => r.manifest.type === type)
    }

    if (query) {
      const q = query.toLowerCase()
      filtered = filtered.filter(
        r =>
          r.manifest.name.toLowerCase().includes(q) ||
          r.manifest.description?.toLowerCase().includes(q) ||
          r.manifest.tags?.some(t => t.toLowerCase().includes(q))
      )
    }

    setResources(filtered)
  }, [allResources, type, query])

  const counts = {
    all: allResources.length,
    skill: allResources.filter(r => r.manifest.type === "skill").length,
    agent: allResources.filter(r => r.manifest.type === "agent").length,
    workflow: allResources.filter(r => r.manifest.type === "workflow").length,
    source: allResources.filter(r => r.manifest.type === "source").length,
  }

  return { resources, loading, error, refetch: fetchResources, counts }
}
