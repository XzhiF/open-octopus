'use client'

import { useEffect, useState } from 'react'
import { listRunningSessions, type RunningAgentSession } from '@/lib/agent/api'

const POLL_MS = 2_000

/** Agent sessions with a live generation stream. Failures keep the last good list. */
export function useRunningAgents(): RunningAgentSession[] {
  const [agents, setAgents] = useState<RunningAgentSession[]>([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const { items } = await listRunningSessions()
        if (!cancelled) setAgents(Array.isArray(items) ? items : [])
      } catch {
        /* server unavailable — keep the previous snapshot */
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    const onVisibility = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return agents
}
