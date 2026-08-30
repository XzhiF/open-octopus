"use client"

import { useState, useEffect, useCallback } from "react"
import { WorkspaceList } from "@/components/workspaces/workspace-list"
import { listWorkspaces } from "@/lib/api-client"
import type { Workspace } from "@/lib/types"

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    if (!silent) setError(null)
    try {
      const data = await listWorkspaces()
      setWorkspaces(Array.isArray(data) ? data : data.workspaces ?? [])
      if (!silent) setError(null)
    } catch (err) {
      // 静默轮询失败时保留现有数据，不打断页面
      if (!silent) setError(err instanceof Error ? err.message : "获取工作空间列表失败")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // 轮询刷新运行状态（黄色蚂蚁边特效依赖）
  useEffect(() => {
    const timer = setInterval(() => fetchData(true), 5000)
    return () => clearInterval(timer)
  }, [fetchData])

  return (
    <div className="container mx-auto px-4 py-6 lg:px-6" data-testid="workspaces-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">工作空间</h1>
        <p className="text-muted-foreground">
          管理您的工作空间、项目和工作流
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12" data-testid="workspace-list-loading">
          <p className="text-muted-foreground">加载中...</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center" data-testid="workspace-list-error">
          <p className="text-destructive">{error}</p>
          <button
            className="mt-4 text-sm text-primary underline"
            onClick={() => fetchData()}
            data-testid="workspace-list-retry"
          >
            重试
          </button>
        </div>
      ) : (
        <WorkspaceList workspaces={workspaces} onRefresh={fetchData} />
      )}
    </div>
  )
}