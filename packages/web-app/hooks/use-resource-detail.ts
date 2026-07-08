"use client"

import { useState, useEffect } from "react"
import { getResource } from "@/lib/resource/api"
import type { ResourceEntry } from "@/lib/resource/types"

interface UseResourceDetailResult {
  resource: ResourceEntry | null
  loading: boolean
  error: string | null
}

export function useResourceDetail(
  org: string,
  type: string | undefined,
  name: string | undefined,
): UseResourceDetailResult {
  const [resource, setResource] = useState<ResourceEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!type || !name) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    getResource(org, type, name)
      .then(setResource)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load resource")
        setResource(null)
      })
      .finally(() => setLoading(false))
  }, [org, type, name])

  return { resource, loading, error }
}
