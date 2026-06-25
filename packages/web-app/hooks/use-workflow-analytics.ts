"use client"

import { useState, useEffect } from "react"
import { fetchWorkspaceAnalytics, fetchWorkflowAnalytics } from "@/lib/observability-api"
import type { WorkspaceAnalytics } from "@/lib/types"

interface WorkspaceAnalyticsResponse {
  data: WorkspaceAnalytics | null
  workflows: Array<{ workflow_ref: string; executions: number; success_rate: number | null; avg_duration_ms: number | null }>
  dailyTrend: Array<{ date: string; executions: number; success_rate: number | null }>
}

export function useWorkspaceAnalytics(workspaceId: string, range = '7d') {
  const [data, setData] = useState<WorkspaceAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setLoading(true)
    fetchWorkspaceAnalytics(workspaceId, range)
      .then(r => { if (!cancelled) setData(r as WorkspaceAnalyticsResponse) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e : new Error(String(e))) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, range])

  useEffect(() => {
    if (!data?.data) return
    const interval = setInterval(() => {
      fetchWorkspaceAnalytics(workspaceId, range).then(r => setData(r as WorkspaceAnalyticsResponse)).catch(() => {})
    }, 60000)
    return () => clearInterval(interval)
  }, [workspaceId, range, data?.data])

  return { data, loading, error }
}

export function useWorkflowAnalytics(workspaceId: string, workflowRef: string, range = '7d') {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!workspaceId || !workflowRef) return
    let cancelled = false
    setLoading(true)
    fetchWorkflowAnalytics(workspaceId, workflowRef, range)
      .then(r => { if (!cancelled) setData(r as Record<string, unknown>) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e : new Error(String(e))) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, workflowRef, range])

  return { data, loading, error }
}
