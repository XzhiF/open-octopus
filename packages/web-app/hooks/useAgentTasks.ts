'use client'

import { useState, useCallback, useEffect } from 'react'
import type { TaskInfo, ScheduledJob, ReportInfo } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { getServerUrl } from '@/lib/server-config'

export function useAgentTasks() {
  const [activeTasks, setActiveTasks] = useState<TaskInfo[]>([])
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([])
  const [reports, setReports] = useState<ReportInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.getTasks()
      setActiveTasks(res.active)
      setScheduledJobs(res.scheduled)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchReports = useCallback(async (query?: { task?: string; q?: string }) => {
    try {
      const res = await api.getReports(query)
      setReports(res.items)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load reports')
    }
  }, [])

  const cancelTask = useCallback(async (id: string) => {
    try {
      await api.cancelTask(id)
      setActiveTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'cancelled' as const } : t))
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel task')
      return false
    }
  }, [])

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch(`${getServerUrl()}/api/agent/tasks/progress`, {
        headers: { 'Authorization': 'Bearer agent' },
      })
      if (!res.ok) return
      const data = await res.json()
      // Merge progress data into active tasks (update progress %, current_node, status)
      if (data.executions?.length > 0) {
        setActiveTasks(prev =>
          prev.map(task => {
            const exec = data.executions.find((e: { id: string }) => e.id === task.id)
            if (exec) {
              return {
                ...task,
                status: exec.status === 'running' ? 'running' as const : task.status,
                current_node: exec.current_node ?? task.current_node,
                progress: exec.progress ?? task.progress,
                elapsed_ms: exec.elapsed_ms ?? task.elapsed_ms,
              }
            }
            return task
          }),
        )
      }
    } catch {
      // Polling failures are silent — next poll will retry
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchTasks()
    fetchReports()
  }, [fetchTasks, fetchReports])

  // Poll progress every 8 seconds while there are active tasks
  useEffect(() => {
    if (activeTasks.length === 0) return
    const interval = setInterval(pollProgress, 8000)
    return () => clearInterval(interval)
  }, [activeTasks.length, pollProgress])

  return {
    activeTasks,
    scheduledJobs,
    reports,
    loading,
    error,
    cancelTask,
    refetch: fetchTasks,
    refetchReports: fetchReports,
  }
}
