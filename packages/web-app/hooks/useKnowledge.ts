'use client'

import { useState, useEffect, useCallback } from 'react'
import type { KnowledgeFile } from '@/lib/knowledge/types'
import * as api from '@/lib/knowledge/api'

export type KnowledgeScope = 'global' | 'org'

export function useKnowledge(initialScope: KnowledgeScope = 'global') {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [preference, setPreference] = useState<{ content: string; scope: string }>({
    content: '',
    scope: initialScope,
  })
  const [scope, setScope] = useState<KnowledgeScope>(initialScope)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async (currentScope: KnowledgeScope) => {
    try {
      setLoading(true)
      setError(null)
      const [filesRes, prefRes] = await Promise.all([
        api.getKnowledgeFiles(currentScope),
        api.getPreference(currentScope),
      ])
      setFiles(filesRes)
      setPreference({ content: prefRes.content ?? '', scope: currentScope })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge data')
    } finally {
      setLoading(false)
    }
  }, [])

  const updateScope = useCallback((newScope: KnowledgeScope) => {
    setScope(newScope)
  }, [])

  const refetch = useCallback(() => {
    return fetchData(scope)
  }, [fetchData, scope])

  useEffect(() => {
    fetchData(scope)
  }, [fetchData, scope])

  return {
    files,
    preference,
    scope,
    setScope: updateScope,
    loading,
    error,
    refetch,
  }
}
