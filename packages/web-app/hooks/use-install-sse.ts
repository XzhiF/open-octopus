import { useState, useCallback } from "react"
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

export function useInstallSSE() {
  const [status, setStatus] = useState<InstallStatus>("idle")
  const [progress, setProgress] = useState<InstallProgress[]>([])
  const [result, setResult] = useState<InstallComplete | null>(null)
  const [sseUrl, setSseUrl] = useState<string | null>(null)

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data)
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
    setStatus("dropped")
  }, [])

  useSSESubscription({
    url: sseUrl,
    onMessage: handleMessage,
    onError: handleError,
  })

  const start = useCallback((installId: string) => {
    setProgress([])
    setResult(null)
    setStatus("connecting")
    setSseUrl(resourceApi.getInstallSSEUrl(installId))
    setStatus("streaming")
  }, [])

  const reset = useCallback(() => {
    setStatus("idle")
    setProgress([])
    setResult(null)
    setSseUrl(null)
  }, [])

  return { status, progress, result, start, reset }
}
