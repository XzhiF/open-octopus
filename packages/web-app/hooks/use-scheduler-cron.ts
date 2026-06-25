"use client"

import { useState, useCallback, useRef } from "react"
import { parseCron, type CronParseResult } from "@/lib/scheduler-api"

const DEBOUNCE_MS = 500

export function useSchedulerCron() {
  const [result, setResult] = useState<CronParseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const parse = useCallback((expression: string, timezone: string) => {
    // Cancel previous debounce timer
    if (timerRef.current) clearTimeout(timerRef.current)
    // Abort previous in-flight request
    abortRef.current?.abort()

    if (!expression.trim()) {
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const data = await parseCron(expression, timezone)
        if (controller.signal.aborted) return
        setResult(data)
        setError(null)
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        if (err instanceof Error && err.name === "AbortError") return
        setResult(null)
        setError(err instanceof Error ? err.message : "Parse failed")
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }, DEBOUNCE_MS)
  }, [])

  return { result, loading, error, parse }
}
