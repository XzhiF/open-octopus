"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { searchLessons, type ExperienceItem } from "@/lib/archive-api"

export function useExperienceSearch(initialQuery: string = "", limit: number = 20) {
  const [query, setQuery] = useState(initialQuery)
  const [lessons, setLessons] = useState<ExperienceItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const search = useCallback((q: string) => {
    setQuery(q)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setLoading(true)
      setError(null)
      searchLessons(q || undefined, limit)
        .then(res => { setLessons(res.lessons); setTotal(res.total) })
        .catch(setError)
        .finally(() => setLoading(false))
    }, 300)
  }, [limit])

  // Initial load
  useEffect(() => {
    search(initialQuery)
    return () => clearTimeout(timerRef.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { query, lessons, total, loading, error, search }
}
