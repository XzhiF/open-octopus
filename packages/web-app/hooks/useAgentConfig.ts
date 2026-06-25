'use client'

import { useState, useCallback, useEffect } from 'react'
import type { AgentConfig, SafeModeStatus, SafetyEvent } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'

export function useAgentConfig() {
  const [config, setConfig] = useState<(AgentConfig & { config_degraded: boolean }) | null>(null)
  const [safeMode, setSafeMode] = useState<SafeModeStatus | null>(null)
  const [safetyEvents, setSafetyEvents] = useState<SafetyEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [cfg, sm] = await Promise.all([api.getConfig(), api.getSafeMode()])
      setConfig(cfg)
      setSafeMode(sm)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }, [])

  const saveConfig = useCallback(async (data: Partial<AgentConfig>) => {
    try {
      setSaving(true)
      setError(null)
      await api.updateConfig(data)
      setConfig(prev => prev ? { ...prev, ...data } : prev)
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save config')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const savePersona = useCallback(async (content: string) => {
    try {
      setSaving(true)
      setError(null)
      await api.updatePersona(content)
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save persona')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const toggleSafeMode = useCallback(async (enable: boolean) => {
    try {
      if (enable) {
        await api.enableSafeMode()
      } else {
        await api.disableSafeMode()
      }
      const sm = await api.getSafeMode()
      setSafeMode(sm)
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to toggle safe mode')
      return false
    }
  }, [])

  const fetchSafetyEvents = useCallback(async () => {
    try {
      const res = await api.getSafetyEvents({ limit: 50 })
      setSafetyEvents(res.items)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load safety events')
    }
  }, [])

  useEffect(() => {
    fetchConfig()
    fetchSafetyEvents()
  }, [fetchConfig, fetchSafetyEvents])

  return {
    config,
    safeMode,
    safetyEvents,
    loading,
    saving,
    error,
    saveConfig,
    savePersona,
    toggleSafeMode,
    refetch: fetchConfig,
  }
}
