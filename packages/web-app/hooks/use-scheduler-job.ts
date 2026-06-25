"use client"

import { useState, useCallback } from "react"
import { getJob, type SchedulerJob } from "@/lib/scheduler-api"

export function useSchedulerJob() {
  const [job, setJob] = useState<SchedulerJob | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchJob = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await getJob(id)
      setJob(data)
      return data
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load job"
      setError(msg)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const mutate = useCallback(
    async (id: string) => {
      return fetchJob(id)
    },
    [fetchJob]
  )

  return { job, setJob, loading, error, fetchJob, mutate }
}
