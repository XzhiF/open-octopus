'use client'

import { useState, useCallback } from 'react'
import type { MemoryContent, MemorySearchResult, MemoryLayer } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'

export function useAgentMemory() {
  const [content, setContent] = useState<MemoryContent | MemoryContent[] | null>(null)
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([])
  const [searchDegraded, setSearchDegraded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchMemory = useCallback(async (layer: MemoryLayer, query?: { clone?: string; date?: string }) => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.getMemory(layer, query)
      setContent(res)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load memory')
    } finally {
      setLoading(false)
    }
  }, [])

  const saveMemory = useCallback(async (layer: MemoryLayer, contentStr: string) => {
    try {
      setSaving(true)
      setError(null)
      await api.addMemory({ layer, content: contentStr })
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save memory')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const search = useCallback(async (q: string, limit?: number) => {
    if (!q.trim()) {
      setSearchResults([])
      return
    }
    try {
      setLoading(true)
      setError(null)
      const res = await api.searchMemory(q, limit)
      setSearchResults(res.results)
      setSearchDegraded(res.degraded)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [])

  return {
    content,
    searchResults,
    searchDegraded,
    loading,
    saving,
    error,
    fetchMemory,
    saveMemory,
    search,
  }
}
