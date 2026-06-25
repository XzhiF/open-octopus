'use client'

import { useState, useCallback, useEffect } from 'react'
import type { CloneInfo, CreateCloneRequest } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'

export function useAgentClones() {
  const [clones, setClones] = useState<CloneInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchClones = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.listClones()
      setClones(res.clones)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load clones')
    } finally {
      setLoading(false)
    }
  }, [])

  const create = useCallback(async (data: CreateCloneRequest) => {
    try {
      const clone = await api.createClone(data)
      setClones(prev => [...prev, clone])
      return clone
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create clone')
      return null
    }
  }, [])

  const merge = useCallback(async (name: string) => {
    try {
      await api.mergeClone(name)
      setClones(prev => prev.filter(c => c.name !== name))
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to merge clone')
      return false
    }
  }, [])

  const remove = useCallback(async (name: string, keepWorkspace = true) => {
    try {
      await api.deleteClone(name, keepWorkspace)
      setClones(prev => prev.filter(c => c.name !== name))
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete clone')
      return false
    }
  }, [])

  useEffect(() => { fetchClones() }, [fetchClones])

  return { clones, loading, error, create, merge, remove, refetch: fetchClones }
}
