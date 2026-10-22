"use client"

import { useCallback, useEffect, useState } from "react"
import {
  TASK_EXECUTION_EVENT,
  TASK_STATUS_EVENT,
  type TaskStatus,
} from "@octopus/shared"
import { listTasks, type TaskView } from "@/lib/tasks-api"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"

const ACTIVE_STATUSES: TaskStatus[] = [
  "running",
  "paused",
  "awaiting_review",
  "archiving",
]

const STATUS_RANK: Record<string, number> = {
  running: 0,
  awaiting_review: 1,
  paused: 2,
  archiving: 3,
}

const MAX_VISIBLE = 5

/** Active tasks for the work dock: four in-flight statuses, live via SSE. */
export function useActiveTasks() {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [loading, setLoading] = useState(true)

  const fetchTasks = useCallback(async () => {
    try {
      const { items } = await listTasks()
      const active = items
        .filter((task) => ACTIVE_STATUSES.includes(task.status))
        .sort((a, b) => {
          const rank = (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
          return rank !== 0 ? rank : b.updated_at.localeCompare(a.updated_at)
        })
      setTasks(active)
    } catch {
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchTasks()
  }, [fetchTasks])

  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    const offStatus = subscribeSSE(url, TASK_STATUS_EVENT, () => {
      void fetchTasks()
    })
    const offExecution = subscribeSSE(url, TASK_EXECUTION_EVENT, () => {
      void fetchTasks()
    })
    return () => {
      offStatus()
      offExecution()
    }
  }, [fetchTasks])

  // SSE covers normal transitions; the poll is a safety net for gaps/reconnects.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchTasks()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [fetchTasks])

  return {
    tasks: tasks.slice(0, MAX_VISIBLE),
    total: tasks.length,
    loading,
  }
}
