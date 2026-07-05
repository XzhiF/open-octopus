import { useState, useEffect, useCallback } from "react"
import { resourceApi } from "@/lib/api-client"
import type { TrustEntry, BlockedEntry } from "@/lib/types"

interface UseTrustSourcesReturn {
  trusted: TrustEntry[]
  blocked: BlockedEntry[]
  loading: boolean
  error: string | null
  refetch: () => void
  addTrust: (protocol: string, pkg: string) => Promise<void>
  removeTrust: (protocol: string, pkg: string) => Promise<void>
  addBlock: (protocol: string, pkg: string, reason?: string) => Promise<void>
  removeBlock: (protocol: string, pkg: string) => Promise<void>
}

export function useTrustSources(): UseTrustSourcesReturn {
  const [trusted, setTrusted] = useState<TrustEntry[]>([])
  const [blocked, setBlocked] = useState<BlockedEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTrust = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await resourceApi.listTrust()
      setTrusted(data.trusted)
      setBlocked(data.blocked)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载信任来源失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTrust()
  }, [fetchTrust])

  const addTrust = useCallback(async (protocol: string, pkg: string) => {
    // Optimistic update
    const newEntry: TrustEntry = {
      protocol,
      location: pkg,
      trusted_at: new Date().toISOString(),
    }
    const prevTrusted = trusted
    setTrusted(prev => [...prev, newEntry])
    try {
      await resourceApi.addTrust(protocol, pkg)
    } catch (err) {
      setTrusted(prevTrusted)
      throw err
    }
  }, [trusted])

  const removeTrust = useCallback(async (protocol: string, pkg: string) => {
    const prevTrusted = trusted
    setTrusted(prev => prev.filter(t => !(t.protocol === protocol && t.location === pkg)))
    try {
      await resourceApi.removeTrust(protocol, pkg)
    } catch (err) {
      setTrusted(prevTrusted)
      throw err
    }
  }, [trusted])

  const addBlock = useCallback(async (protocol: string, pkg: string, reason?: string) => {
    const newEntry: BlockedEntry = {
      protocol,
      location: pkg,
      blocked_at: new Date().toISOString(),
      reason,
    }
    const prevBlocked = blocked
    const wasInTrusted = trusted.some(t => t.protocol === protocol && t.location === pkg)
    const prevTrustedSnapshot = [...trusted]
    setBlocked(prev => [...prev, newEntry])
    // Also remove from trusted if present
    setTrusted(prev => prev.filter(t => !(t.protocol === protocol && t.location === pkg)))
    try {
      await resourceApi.addBlock(protocol, pkg, reason)
    } catch (err) {
      setBlocked(prevBlocked)
      if (wasInTrusted) {
        setTrusted(prevTrustedSnapshot)
      }
      throw err
    }
  }, [blocked, trusted])

  const removeBlock = useCallback(async (protocol: string, pkg: string) => {
    const prevBlocked = blocked
    setBlocked(prev => prev.filter(b => !(b.protocol === protocol && b.location === pkg)))
    try {
      await resourceApi.removeBlock(protocol, pkg)
    } catch (err) {
      setBlocked(prevBlocked)
      throw err
    }
  }, [blocked])

  return { trusted, blocked, loading, error, refetch: fetchTrust, addTrust, removeTrust, addBlock, removeBlock }
}
