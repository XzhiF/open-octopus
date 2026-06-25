"use client"

import { useState, useCallback, useEffect } from "react"
import type { Schedule, CreateScheduleInput, UpdateScheduleInput } from "@/lib/types"
import * as api from "@/lib/schedule-api"

export function useSchedules(wsId: string) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!wsId) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.listSchedules(wsId)
      setSchedules(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load schedules")
    } finally {
      setLoading(false)
    }
  }, [wsId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const create = useCallback(
    async (input: CreateScheduleInput) => {
      const created = await api.createSchedule(wsId, input)
      setSchedules((prev) => [...prev, created])
      return created
    },
    [wsId]
  )

  const update = useCallback(
    async (id: string, input: UpdateScheduleInput) => {
      const updated = await api.updateSchedule(wsId, id, input)
      setSchedules((prev) => prev.map((s) => (s.id === id ? updated : s)))
      return updated
    },
    [wsId]
  )

  const remove = useCallback(
    async (id: string) => {
      await api.deleteSchedule(wsId, id)
      setSchedules((prev) => prev.filter((s) => s.id !== id))
    },
    [wsId]
  )

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      const updated = enabled
        ? await api.enableSchedule(wsId, id)
        : await api.disableSchedule(wsId, id)
      setSchedules((prev) => prev.map((s) => (s.id === id ? updated : s)))
      return updated
    },
    [wsId]
  )

  const trigger = useCallback(
    async (id: string) => {
      return api.triggerSchedule(wsId, id)
    },
    [wsId]
  )

  return { schedules, loading, error, refresh, create, update, remove, toggle, trigger }
}
