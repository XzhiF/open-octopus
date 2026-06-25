"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import type { CronParseResult, NaturalLanguageCronResult } from "@/lib/types"
import * as api from "@/lib/schedule-api"

const DEBOUNCE_MS = 300

export function useCronParse(expression: string, timezone: string) {
  const [result, setResult] = useState<CronParseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!expression.trim()) {
      setResult(null)
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)
    setLoading(true)

    timerRef.current = setTimeout(async () => {
      try {
        const data = await api.parseCron(expression, timezone)
        setResult(data)
      } catch {
        setResult({ valid: false, description: "Parse error", nextExecutions: [], error: "Failed to parse" })
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [expression, timezone])

  return { result, loading }
}

export function useNaturalLanguageCron() {
  const [result, setResult] = useState<NaturalLanguageCronResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const convert = useCallback(async (input: string) => {
    if (!input.trim()) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.naturalLanguageToCron(input)
      setResult(data)
      if (data.confidence === "error") {
        setError(data.error ?? "Unable to convert")
      }
      return data
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Conversion failed"
      setError(msg)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  return { result, loading, error, convert }
}
