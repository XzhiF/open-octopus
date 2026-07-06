import { useState, useCallback, useRef } from "react"
import { useSSESubscription } from "@/hooks/use-sse-subscription"
import { resourceApi } from "@/lib/api-client"
import type { InstallProgress, InstallComplete } from "@/lib/types"

export type InstallStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "complete"
  | "error"
  | "dropped"

const MAX_RECONNECT_ATTEMPTS = 3

export function useInstallSSE() {
  const [status, setStatus] = useState<InstallStatus>("idle")
  const [progress, setProgress] = useState<InstallProgress[]>([])
  const [result, setResult] = useState<InstallComplete | null>(null)
  const [sseUrl, setSseUrl] = useState<string | null>(null)
  const lastTimestampRef = useRef<string | undefined>(undefined)
  const reconnectCountRef = useRef(0)
  const installIdRef = useRef<string | null>(null)

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data)
      // Track last event timestamp for reconnection
      if (data.timestamp) {
        lastTimestampRef.current = data.timestamp
      }
      reconnectCountRef.current = 0 // Reset on successful message
      if (data.type === "install_progress") {
        setProgress(prev => [...prev, data as InstallProgress])
      } else if (data.type === "install_complete") {
        setResult(data as InstallComplete)
        setStatus("complete")
      } else if (data.type === "install_error") {
        setStatus("error")
      }
    } catch {
      // ignore malformed messages
    }
  }, [])

  const handleError = useCallback(() => {
    // F10: Auto-reconnect with ?since= for resume after disconnect
    if (
      installIdRef.current &&
      reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS &&
      status !== "complete" &&
      status !== "error"
    ) {
      reconnectCountRef.current++
      const since = lastTimestampRef.current
      const url = resourceApi.getInstallSSEUrl(installIdRef.current, since)
      setStatus("connecting")
      setSseUrl(url)
      setTimeout(() => setStatus("streaming"), 100)
    } else {
      setStatus("dropped")
    }
  }, [status])

  useSSESubscription({
    url: sseUrl,
    onMessage: handleMessage,
    onError: handleError,
  })

  const start = useCallback((installId: string) => {
    setProgress([])
    setResult(null)
    setStatus("connecting")
    lastTimestampRef.current = undefined
    reconnectCountRef.current = 0
    installIdRef.current = installId
    setSseUrl(resourceApi.getInstallSSEUrl(installId))
    setStatus("streaming")
  }, [])

  const reset = useCallback(() => {
    setStatus("idle")
    setProgress([])
    setResult(null)
    setSseUrl(null)
    lastTimestampRef.current = undefined
    reconnectCountRef.current = 0
    installIdRef.current = null
  }, [])

  return { status, progress, result, start, reset }
}
