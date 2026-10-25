'use client'

import { useState, useCallback, useEffect } from 'react'
import type { AgentSession } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'

export function useAgentSessions() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.listSessions({ limit: 50 })
      setSessions(res.items)
      // Auto-select the newest *main* chat; task-author clone sessions are
      // opened from the task list, never as the default conversation.
      if (res.items.length > 0) {
        const preferred = res.items.find((session) => !session.clone_name) ?? res.items[0]
        setActiveSessionId(prev => prev ?? preferred.id)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  const createNewSession = useCallback(async (opts?: { cwd?: string; workspace_id?: string }) => {
    try {
      const session = await api.createSession(opts)
      setSessions(prev => [session, ...prev])
      setActiveSessionId(session.id)
      return session
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
      return null
    }
  }, [])

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      await api.updateSession(id, { title })
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rename session')
    }
  }, [])

  const removeSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeSessionId === id) {
        setActiveSessionId(null)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    }
  }, [activeSessionId])

  // Update title in local state only (when server already updated it, e.g. auto-title)
  const updateSessionTitle = useCallback((id: string, title: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s))
  }, [])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    loading,
    error,
    createNewSession,
    renameSession,
    removeSession,
    updateSessionTitle,
    refetch: fetchSessions,
  }
}
