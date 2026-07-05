import { useState, useEffect, useCallback } from "react"
import { resourceApi } from "@/lib/api-client"
import type { Resource } from "@/lib/types"

interface UseResourceDetailReturn {
  resource: Resource | null
  loading: boolean
  error: string | null
  notFound: boolean
  refetch: () => void
}

export function useResourceDetail(type: string, name: string): UseResourceDetailReturn {
  const [resource, setResource] = useState<Resource | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const data = await resourceApi.detail(type, name)
      setResource(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : "加载资源详情失败"
      if (message.includes("404") || message.includes("not found")) {
        setNotFound(true)
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }, [type, name])

  useEffect(() => {
    if (type && name) {
      fetchDetail()
    }
  }, [fetchDetail, type, name])

  return { resource, loading, error, notFound, refetch: fetchDetail }
}
