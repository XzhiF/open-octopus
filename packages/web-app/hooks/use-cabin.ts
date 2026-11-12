'use client'

// Single-cabin live state: DTO + derived view + init-gate snapshot, folded from
// the `cabin:<id>` SSE channel (cabin_status / cabin_init_progress) with a
// coalesced refetch. The view is server-derived (K3) — this hook never computes
// attention/health/progress itself, it only transports them.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CabinInitState, CabinView } from '@octopus/shared'
import {
  getCabin, getCabinInit, cabinEventsUrl, CabinApiError, type CabinDetail,
} from '@/lib/cabin-api'
import { subscribeSSE } from '@/lib/sse-manager'

export function useCabin(cabinId: string | null) {
  const [cabin, setCabin] = useState<CabinDetail | null>(null)
  const [view, setView] = useState<CabinView | null>(null)
  const [initState, setInitState] = useState<CabinInitState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    if (!cabinId) return
    try {
      const [detail, init] = await Promise.all([getCabin(cabinId), getCabinInit(cabinId)])
      if (!aliveRef.current) return
      setCabin(detail.cabin)
      setView(detail.view)
      setInitState(init.state)
      setError(null)
    } catch (err) {
      if (!aliveRef.current) return
      if (err instanceof CabinApiError && err.status === 404) setError('not-found')
      else setError(err instanceof Error ? err.message : '加载舱失败')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [cabinId])

  useEffect(() => {
    aliveRef.current = true
    setLoading(true)
    setCabin(null)
    setView(null)
    setInitState(null)
    setError(null)
    void refresh()
    return () => { aliveRef.current = false }
  }, [refresh])

  useEffect(() => {
    if (!cabinId) return
    const url = cabinEventsUrl(cabinId)
    let timer: number | null = null
    // Progress fires per gate item — coalesce the refetch burst into one.
    const scheduleRefresh = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => { timer = null; void refresh() }, 300)
    }
    const offStatus = subscribeSSE(url, 'cabin_status', () => scheduleRefresh())
    const offProgress = subscribeSSE(url, 'cabin_init_progress', (e) => {
      try {
        const data = JSON.parse(e.data) as { cabin_id?: string; items?: CabinInitState['items'] }
        if (data.cabin_id === cabinId && Array.isArray(data.items)) {
          setInitState({ items: data.items })
        }
      } catch { /* malformed frame — the refetch still reconciles */ }
      scheduleRefresh()
    })
    const poll = window.setInterval(() => void refresh(), 30_000)
    return () => {
      offStatus()
      offProgress()
      if (timer !== null) window.clearTimeout(timer)
      window.clearInterval(poll)
    }
  }, [cabinId, refresh])

  return { cabin, view, initState, loading, error, refresh }
}