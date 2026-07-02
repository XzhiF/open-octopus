"use client"

import { useState, useEffect } from "react"
import { listOrgs } from "@/lib/api-client"

export interface OrgOption {
  id: number
  name: string
  path: string
}

/**
 * Fetch the list of orgs registered in the database.
 *
 * Mirrors the shape of `useWorkspaces`:
 *   { orgs, loading, error }
 *
 * Used by the PreferenceEditor card waterfall to render one card per org
 * plus the "global" card.
 */
export function useOrgs() {
  const [orgs, setOrgs] = useState<OrgOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listOrgs()
      .then((rows) => {
        if (cancelled) return
        setOrgs(Array.isArray(rows) ? rows : [])
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setOrgs([])
        setError(err instanceof Error ? err.message : "加载组织列表失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { orgs, loading, error }
}
