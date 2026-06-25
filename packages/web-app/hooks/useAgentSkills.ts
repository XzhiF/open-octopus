'use client'

import { useState, useCallback, useEffect } from 'react'
import type { SkillInfo, EvolutionLogEntry, Experience } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'

export function useAgentSkills() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [changelog, setChangelog] = useState<EvolutionLogEntry[]>([])
  const [experiences, setExperiences] = useState<Experience[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSkills = useCallback(async () => {
    try {
      setLoading(true)
      const res = await api.listSkills()
      setSkills(res.skills ?? res.items ?? [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchChangelog = useCallback(async (query?: { skill?: string; limit?: number }) => {
    try {
      const res = await api.getChangelog(query)
      setChangelog(res.items)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load changelog')
    }
  }, [])

  const fetchExperiences = useCallback(async (query?: { skill?: string; q?: string }) => {
    try {
      const res = await api.getExperiences(query)
      setExperiences(res.experiences ?? res.items ?? [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load experiences')
    }
  }, [])

  const rollback = useCallback(async (id: number) => {
    try {
      await api.rollbackEvolution(id)
      await fetchChangelog()
      await fetchSkills()
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Rollback failed')
      return false
    }
  }, [fetchChangelog, fetchSkills])

  const revertToBuiltin = useCallback(async (name: string) => {
    try {
      await api.revertToBuiltin(name)
      await fetchSkills()
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Revert failed')
      return false
    }
  }, [fetchSkills])

  useEffect(() => {
    fetchSkills()
    fetchChangelog()
  }, [fetchSkills, fetchChangelog])

  return {
    skills,
    changelog,
    experiences,
    loading,
    error,
    fetchChangelog,
    fetchExperiences,
    rollback,
    revertToBuiltin,
    refetch: fetchSkills,
  }
}
