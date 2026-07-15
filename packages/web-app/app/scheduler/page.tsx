"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSchedulerJobs } from "@/hooks/use-scheduler-jobs"
import { useSchedulerDashboard } from "@/hooks/use-scheduler-dashboard"
import { toast } from "@/hooks/use-toast"
import {
  deleteJob as apiDeleteJob,
  triggerJob as apiTriggerJob,
  type SchedulerJob,
} from "@/lib/scheduler-api"
import { listWorkspaces } from "@/lib/api-client"
import { DashboardCards } from "@/components/scheduler/dashboard-cards"
import { FilterBar } from "@/components/scheduler/filter-bar"
import { SchedulerTable } from "@/components/scheduler/scheduler-table"
import { Pagination } from "@/components/scheduler/pagination"
import { EmptyState } from "@/components/scheduler/empty-state"
import { ErrorState } from "@/components/scheduler/error-state"
import { DeleteConfirmDialog } from "@/components/scheduler/delete-confirm-dialog"
import { SchedulerForm } from "@/components/scheduler/scheduler-form"
import { ExportDialog } from "@/components/scheduler/export-dialog"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { ChatPanel } from "@/components/workspace/chat/chat-panel"
import { useChatStream } from "@/components/workspace/chat/use-chat-stream"

const PAGE_SIZE = 20

export default function SchedulerPage() {
  const {
    jobs,
    total,
    page,
    setPage,
    loading,
    error,
    filters,
    updateFilters,
    clearFilters,
    toggleJob,
    refetch,
  } = useSchedulerJobs(PAGE_SIZE)

  const { data: dashboardData, loading: dashboardLoading, fetchDashboard } =
    useSchedulerDashboard()

  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
    []
  )
  const [formOpen, setFormOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<SchedulerJob | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteJobTarget, setDeleteJobTarget] =
    useState<SchedulerJob | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [dashboardRange, setDashboardRange] = useState<"all" | "24h" | "7d" | "30d">("all")
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null
    return localStorage.getItem("octopus:scheduler:activeSession")
  })

  // Global chat: workspaceId = null, apiBase = '/api/chat/global'
  const chat = useChatStream(null, activeSessionId, {
    apiBase: '/api/chat/global',
    onSessionCreated: (id) => setActiveSessionId(id),
  })

  // Auto-select first session when sessions load and none is active.
  // Also clears stale activeSessionId if the session no longer exists.
  const initialSelectDone = useRef(false)
  useEffect(() => {
    if (chat.sessions.length === 0) return

    // Validate activeSessionId against loaded sessions
    if (activeSessionId && !chat.sessions.some((s) => s.id === activeSessionId)) {
      localStorage.removeItem("octopus:scheduler:activeSession")
      setActiveSessionId(null)
      initialSelectDone.current = false
      return
    }

    if (!activeSessionId && !initialSelectDone.current) {
      initialSelectDone.current = true
      const first = chat.sessions[0]
      setActiveSessionId(first.id)
      chat.switchSession(first.id)
    }
  }, [activeSessionId, chat.sessions, chat.switchSession])

  // Persist active session to localStorage
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem("octopus:scheduler:activeSession", activeSessionId)
    } else {
      localStorage.removeItem("octopus:scheduler:activeSession")
    }
  }, [activeSessionId])

  useEffect(() => {
    fetchDashboard({ range: dashboardRange })
  }, [fetchDashboard, dashboardRange])

  useEffect(() => {
    listWorkspaces().then((ws: unknown) => {
      if (Array.isArray(ws)) setWorkspaces(ws)
    })
  }, [])

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const hasFilters =
    !!filters.search ||
    !!filters.status ||
    !!filters.job_type ||
    !!filters.workspace_id

  const handleToggle = useCallback(
    async (job: SchedulerJob) => {
      try {
        await toggleJob(job.id)
      } catch {
        toast({
          title: "操作失败",
          description: "无法切换任务状态",
          variant: "destructive",
        })
      }
    },
    [toggleJob]
  )

  const handleEdit = useCallback((job: SchedulerJob) => {
    setEditingJob(job)
    // ponytail: defer dialog open so DropdownMenu's DismissableLayer is
    // fully removed before Dialog's layer is created — prevents the same
    // pointerdown from being caught as "outside" and auto-closing the dialog.
    setTimeout(() => setFormOpen(true), 0)
  }, [])

  const handleDeleteRequest = useCallback((job: SchedulerJob) => {
    setDeleteJobTarget(job)
    setTimeout(() => setDeleteDialogOpen(true), 0)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteJobTarget) return
    setDeleteLoading(true)
    try {
      await apiDeleteJob(deleteJobTarget.id)
      toast({
        title: "已删除",
        description: `任务 "${deleteJobTarget.name}" 已成功删除`,
      })
      setDeleteDialogOpen(false)
      setDeleteJobTarget(null)
      refetch()
      fetchDashboard()
    } catch {
      toast({
        title: "删除失败",
        description: "无法删除任务，请稍后重试",
        variant: "destructive",
      })
    } finally {
      setDeleteLoading(false)
    }
  }, [deleteJobTarget, refetch, fetchDashboard])

  const handleTrigger = useCallback(async (job: SchedulerJob) => {
    try {
      await apiTriggerJob(job.id)
      toast({
        title: "已触发",
        description: (
          <span>
            任务 &quot;{job.name}&quot; 已手动触发 →{" "}
            <a
              href={`/scheduler/jobs/${job.id}`}
              className="underline text-scheduler-primary"
            >
              查看执行详情
            </a>
          </span>
        ),
      })
    } catch {
      toast({
        title: "触发失败",
        description: "无法触发任务，请稍后重试",
        variant: "destructive",
      })
    }
  }, [])

  return (
    <div className="flex flex-1 min-h-0 flex-col">
    <PanelGroup direction="horizontal" className="flex-1">
      {/* 主内容区 75% */}
      <Panel defaultSize={75} minSize={50}>
        <div className="min-w-0 space-y-6 p-6 overflow-auto h-full">
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">调度管理</h1>
            <div className="ml-auto flex gap-2">
              <Button onClick={() => { setEditingJob(null); setFormOpen(true) }}>
                <Plus className="size-4" />
                新建调度
              </Button>
              <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
                <Download className="size-4" />
                导出
              </Button>
            </div>
          </header>

          <DashboardCards data={dashboardData} loading={dashboardLoading} />

          <FilterBar
            filters={filters}
            onFilterChange={updateFilters}
            onClear={clearFilters}
            workspaces={workspaces}
            dashboardRange={dashboardRange}
            onDashboardRangeChange={setDashboardRange}
          />

          {error ? (
            <ErrorState message={error} onRetry={refetch} />
          ) : !loading && jobs.length === 0 ? (
            hasFilters ? (
              <EmptyState
                title="未找到匹配的任务"
                description="尝试调整筛选条件或清除所有筛选"
                action={{ label: "清除筛选", onClick: clearFilters }}
              />
            ) : (
              <EmptyState
                title="暂无调度任务"
                description="创建你的第一个调度任务，自动化你的工作流"
                action={{
                  label: "创建任务",
                  onClick: () => { setEditingJob(null); setFormOpen(true) },
                }}
              />
            )
          ) : (
            <>
              <SchedulerTable
                jobs={jobs}
                onToggle={handleToggle}
                onEdit={handleEdit}
                onDelete={handleDeleteRequest}
                onTrigger={handleTrigger}
                loading={loading}
              />
              {totalPages > 1 && (
                <Pagination
                  currentPage={page}
                  totalPages={totalPages}
                  onPageChange={setPage}
                />
              )}
            </>
          )}

          <DeleteConfirmDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            jobName={deleteJobTarget?.name ?? ""}
            onConfirm={handleDeleteConfirm}
            loading={deleteLoading}
          />

          <SchedulerForm
            open={formOpen}
            onOpenChange={(open) => {
              setFormOpen(open)
              if (!open) setEditingJob(null)
            }}
            editingJob={editingJob}
            onSuccess={() => {
              setFormOpen(false)
              setEditingJob(null)
              refetch()
              fetchDashboard()
            }}
          />

          <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
        </div>
      </Panel>

      <PanelResizeHandle className="w-1 bg-border hover:bg-primary/30 transition-colors" />

      {/* Chat 面板 25% */}
      <Panel defaultSize={25} minSize={15} maxSize={40} className="min-w-0">
        <div className="h-full">
          <ChatPanel
          messages={chat.messages}
          sessions={chat.sessions}
          activeSessionId={activeSessionId}
          isStreaming={chat.isCurrentSessionStreaming}
          status={chat.status}
          streamStartMs={chat.streamStartMs}
          streamEndState={chat.streamEndState}
          hasMoreMessages={chat.hasMoreMessages}
          onLoadMoreMessages={chat.loadMoreMessages}
          onSendMessage={async (content) => {
            const newSessionId = await chat.sendMessage(content)
            if (!activeSessionId && newSessionId) {
              setActiveSessionId(newSessionId)
            }
          }}
          onAbort={chat.abort}
          onCreateSession={async () => {
            const sid = await chat.createSession()
            setActiveSessionId(sid)
            return sid
          }}
          onSelectSession={(sid) => {
            setActiveSessionId(sid)
            chat.switchSession(sid)
          }}
          onDeleteSession={(sid) => {
            chat.deleteSession(sid)
            if (activeSessionId === sid) {
              setActiveSessionId(null)
            }
          }}
          onRenameSession={chat.renameSession}
        />
        </div>
      </Panel>
    </PanelGroup>
    </div>
  )
}
