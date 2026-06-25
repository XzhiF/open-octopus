"use client"

import { useState, useEffect, useCallback } from "react"
import { WorkspaceList } from "@/components/workspaces/workspace-list"
import { listWorkspaces } from "@/lib/api-client"
import type { Workspace } from "@/lib/types"

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listWorkspaces()
      setWorkspaces(Array.isArray(data) ? data : data.workspaces ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取工作空间列表失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return (
    <div className="container mx-auto px-4 py-6 lg:px-6">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">工作空间</h1>
        <p className="text-muted-foreground">
          管理您的工作空间、项目和工作流
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground">加载中...</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <p className="text-destructive">{error}</p>
          <button
            className="mt-4 text-sm text-primary underline"
            onClick={fetchData}
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