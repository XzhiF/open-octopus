import { useEffect, useRef, useCallback } from "react"

export interface UseSSESubscriptionOptions {
  url: string | null
  onMessage?: (event: MessageEvent) => void
  onError?: (error: Event) => void
  onOpen?: () => void
  heartbeatTimeoutMs?: number
}

/**
 * Generic SSE subscription hook.
 * Manages EventSource lifecycle, heartbeat timeout, and cleanup.
 */
export function useSSESubscription(options: UseSSESubscriptionOptions) {
  const { url, onMessage, onError, onOpen, heartbeatTimeoutMs = 300_000 } = options
  const esRef = useRef<EventSource | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      esRef.current?.close()
      esRef.current = null
      onError?.(new Event("timeout"))
    }, heartbeatTimeoutMs)
  }, [heartbeatTimeoutMs, onError])

  useEffect(() => {
    if (!url) return

    const es = new EventSource(url, { withCredentials: true })
    esRef.current = es

    es.onopen = () => {
      resetTimeout()
      onOpen?.()
    }

    es.onmessage = (event: MessageEvent) => {
      resetTimeout()
      onMessage?.(event)
    }

    es.onerror = (error: Event) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      es.close()
      esRef.current = null
      onError?.(error)
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      es.close()
      esRef.current = null
    }
  }, [url, onMessage, onError, onOpen, resetTimeout])

  const close = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    esRef.current?.close()
    esRef.current = null
  }, [])

  return { close }
}
