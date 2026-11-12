'use client'

// Cabin list for the rail switcher. Mirrors use-chat-tasks' posture: fetch +
// SSE-free light polling (the list changes rarely — create/archive/delete).

import { useCallback, useEffect, useState } from 'react'
import { listCabins, type CabinDetail } from '@/lib/cabin-api'

export function useCabins() {
  const [cabins, setCabins] = useState<CabinDetail[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setCabins(await listCabins())
    } catch {
      /* keep the previous list */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  return { cabins, loading, refresh }
}