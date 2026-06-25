"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Play,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/hooks/use-toast"
import { useSchedulerJob } from "@/hooks/use-scheduler-job"
import { useSchedulerExecutions } from "@/hooks/use-scheduler-executions"
import {
  toggleJob,
  deleteJob,
  triggerJob,
} from "@/lib/scheduler-api"

import { ConfigSummaryCard } from "@/components/scheduler/config-summary-card"
import { ExecutionHistoryTable } from "@/components/scheduler/execution-history-table"
import { AuditLogList } from "@/components/scheduler/audit-log-list"
import { WorkspaceHistoryTable } from "@/components/scheduler/workspace-history-table"
import { SchedulerForm } from "@/components/scheduler/scheduler-form"
import { DeleteConfirmDialog } from "@/components/scheduler/delete-confirm-dialog"
import { DetailPageSkeleton } from "@/components/scheduler/skeleton-loader"
import { ErrorState } from "@/components/scheduler/error-state"
import { NotFoundPage } from "@/components/scheduler/not-found-page"

export default function JobDetailPage() {
  const params = useParams()
  const jobId = params.id as string
  const { toast } = useToast()

  const { job, setJob, loading, error, fetchJob } = useSchedulerJob()
  const {
    executions,
    loading: executionsLoading,
    fetchExecutions,
    loadMore,
    hasMore,
  } = useSchedulerExecutions(jobId)

  const [activeTab, setActiveTab] = useState("executions")
  const [showEditForm, setShowEditForm] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!jobId) return
    fetchJob(jobId).then((data) => {
      if (!data) {
        setNotFound(true)
      }
    })
  }, [jobId, fetchJob])

  useEffect(() => {
    if (jobId) {
      fetchExecutions(1)
    }
  }, [jobId, fetchExecutions])

  const handleToggle = useCallback(async () => {
    if (!job) return
    setToggling(true)
    try {
      const updated = await toggleJob(job.id)
      setJob(updated)
      toast({
        title: updated.enabled ? "调度已启用" : "调度已禁用",
      })
    } catch (err: unknown) {
      toast({
        title: "操作失败",
        description: err instanceof Error ? err.message : "未知错误",
        variant: "destructive",
      })
    } finally {
      setToggling(false)
    }
  }, [job, setJob, toast])

  const handleTrigger = useCallback(async () => {
    if (!job) return
    setTriggering(true)
    try {
      await triggerJob(job.id)
      toast({ title: "已手动触发执行" })
      setTimeout(() => fetchExecutions(1), 1000)
    } catch (err: unknown) {
      toast({
        title: "触发失败",
        description: err instanceof Error ? err.message : "未知错误",
        variant: "destructive",
      })
    } finally {
      setTriggering(false)
    }
  }, [job, toast, fetchExecutions])

  const handleDelete = useCallback(async () => {
    if (!job) return
    try {
      await deleteJob(job.id)
      toast({ title: "调度任务已删除" })
      window.location.href = "/scheduler"
    } catch (err: unknown) {
      toast({
        title: "删除失败",
        description: err instanceof Error ? err.message : "未知错误",
        variant: "destructive",
      })
    }
  }, [job, toast])

  const handleEditSuccess = useCallback(() => {
    fetchJob(jobId)
    fetchExecutions(1)
  }, [jobId, fetchJob, fetchExecutions])

  if (notFound) {
    return <NotFoundPage />
  }

  if (loading && !job) {
    return <DetailPageSkeleton />
  }

  if (error && !job) {
    return <ErrorState message={error} onRetry={() => fetchJob(jobId)} />
  }

  if (!job) return null

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <Link
        href="/scheduler"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        返回调度列表
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{job.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {job.job_type === "workflow" ? "Workflow" : "Agent"} 调度任务
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowEditForm(true)}
          >
            <Pencil className="size-3.5" />
            编辑
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTrigger}
            disabled={triggering}
          >
            {triggering ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            手动触发
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="size-3.5" />
            删除
          </Button>
        </div>
      </div>

      <ConfigSummaryCard job={job} onToggle={handleToggle} />

      <Separator />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="executions">执行历史</TabsTrigger>
          <TabsTrigger value="workspaces">执行空间</TabsTrigger>
          <TabsTrigger value="audit">变更记录</TabsTrigger>
        </TabsList>

        <TabsContent value="executions" className="mt-4">
          <ExecutionHistoryTable
            executions={executions}
            jobId={jobId}
            loading={executionsLoading}
            jobType={job.job_type}
          />
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore}>
                加载更多
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="workspaces" className="mt-4">
          <WorkspaceHistoryTable jobId={jobId} maxRetain={job?.max_retain ?? 10} />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <AuditLogList jobId={jobId} />
        </TabsContent>
      </Tabs>

      <SchedulerForm
        open={showEditForm}
        onOpenChange={setShowEditForm}
        editingJob={job}
        onSuccess={handleEditSuccess}
      />

      <DeleteConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
        jobName={job.name}
      />
    </div>
  )
}
