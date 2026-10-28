'use client'

// 2026-10-28 task-thread: the task's whole-lifecycle ledger for the composer
// chip. The session chip answers "how much did this chat cost"; this answers
// "how much did this TASK cost" (chat + every round + fixes + archiving).

import { useEffect, useState } from 'react'
import { getTaskUsage, type TaskUsagePayload } from '@/lib/tasks-api'

export function useTaskUsage(
  taskId: string | null | undefined,
  refreshKey: string | number = '',
): TaskUsagePayload | null {
  const [usage, setUsage] = useState<TaskUsagePayload | null>(null)

  useEffect(() => {
    if (!taskId) {
      setUsage(null)
      return
    }
    let cancelled = false
    getTaskUsage(taskId)
      .then((next) => {
        if (!cancelled) setUsage(next)
      })
      .catch(() => {
        if (!cancelled) setUsage(null)
      })
    return () => { cancelled = true }
  }, [taskId, refreshKey])

  return usage
}
