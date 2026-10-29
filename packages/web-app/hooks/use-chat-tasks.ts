'use client'

import { useCallback, useEffect, useState } from 'react'
import { TASK_EXECUTION_EVENT, TASK_STATUS_EVENT } from '@octopus/shared'
import { getTask, listTasks, type TaskDerivedView, type TaskView } from '@/lib/tasks-api'
import { effectiveStatusOf } from '@/lib/task-board'
import { subscribeSSE } from '@/lib/sse-manager'
import { getServerUrl } from '@/lib/server-config'

/**
 * Task sessions for the chat hub. AI-native: a task starts as a chat session,
 * so drafts (authoring) and awaiting-review (quick edits) both live here.
 * Awaiting-review is a derived status for v4 tasks: the row can still be
 * `running` while its latest round is finished, so list rows alone are not
 * enough — mirror the board's GET /:id derived hydration before filtering.
 */
export function useChatTasks() {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const { items } = await listTasks()
      const v4Items = items.filter((task) => task.task_spec?.format === 'v4')
      const derivedEntries = await Promise.all(
        v4Items.map(async (task) => {
          try {
            const detail = await getTask(task.id)
            return [task.id, detail.derived] as const
          } catch {
            return [task.id, undefined] as const
          }
        }),
      )
      const derivedMap = Object.fromEntries(
        derivedEntries.filter((entry): entry is [string, TaskDerivedView] => entry[1] !== undefined),
      )
      const chatEligible = items
        .map((task) => {
          const effective = effectiveStatusOf(task, derivedMap[task.id])
          return effective === task.status ? task : { ...task, status: effective }
        })
        // Chat is the task's home across its whole lifecycle; legacy drafts
        // without an authoring session still cannot be opened here.
        .filter((task) => task.status !== 'draft' || !!task.source_chat_session_id)
        // 2026-10-29 用户：侧栏任务按创建时间排，新 → 旧（与看板的时间序解耦，
        // ISO 字符串可直接字典序比较）。
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      setTasks(chatEligible)
    } catch {
      /* keep the previous list; the board remains the source of truth */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    const offStatus = subscribeSSE(url, TASK_STATUS_EVENT, () => void refresh())
    const offExecution = subscribeSSE(url, TASK_EXECUTION_EVENT, () => void refresh())
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => {
      offStatus()
      offExecution()
      window.clearInterval(timer)
    }
  }, [refresh])

  return { tasks, loading, refresh }
}
