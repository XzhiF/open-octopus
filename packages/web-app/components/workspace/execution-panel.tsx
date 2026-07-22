"use client"

import { useState, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Execution, StepExecution, StepExecutionStatus } from "@/lib/types"
import { ApprovalDialog } from "./approval-dialog"
import { InterventionDialog } from "./intervention-dialog"
import { TokenUsageDisplay } from "./workflow-nodes/token-usage-display"
import {
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  SkipForward,
  ChevronRight,
  Terminal,
  StopCircle,
  RotateCcw,
  Ban,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import { getServerUrl } from "@/lib/server-config"

interface ExecutionPanelProps {
  execution?: Execution
  workspaceId?: string
  onStop?: () => void
  onRollback?: () => void
  onRefresh?: () => void
}

const stepStatusConfig: Record<
  StepExecutionStatus,
  { icon: React.ElementType; color: string; label: string }
> = {
  pending: { icon: Clock, color: "text-muted-foreground", label: "待开始" },
  running: { icon: Loader2, color: "text-amber-500", label: "执行中" },
  completed: { icon: CheckCircle2, color: "text-emerald-500", label: "完成" },
  failed: { icon: XCircle, color: "text-destructive", label: "失败" },
  skipped: { icon: SkipForward, color: "text-muted-foreground", label: "跳过" },
  cancelled: { icon: Ban, color: "text-muted-foreground", label: "已取消" },
  paused: { icon: PauseCircle, color: "text-violet-500", label: "已暂停" },
  rejected: { icon: Ban, color: "text-orange-500", label: "已拒绝" },
  pending_approval: { icon: ShieldCheck, color: "text-amber-500", label: "待审批" },
}

function StepItem({ step, isLast }: { step: StepExecution; isLast: boolean }) {
  const config = stepStatusConfig[step.status]
  const Icon = config.icon
  const isRunning = step.status === "running"

  return (
    <div className="relative flex gap-3">
      {/* Timeline */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border-2",
            step.status === "completed" && "border-emerald-500 bg-emerald-500/10",
            step.status === "failed" && "border-destructive bg-destructive/10",
            step.status === "running" && "border-amber-500 bg-amber-500/10",
            step.status === "pending" && "border-border bg-muted",
            step.status === "skipped" && "border-border bg-muted",
            step.status === "cancelled" && "border-border bg-muted",
            step.status === "paused" && "border-violet-500 bg-violet-500/10"
          )}
        >
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              config.color,
              isRunning && "animate-spin"
            )}
          />
        </div>
        {!isLast && (
          <div
            className={cn(
              "h-full w-0.5 flex-1",
              step.status === "completed" ? "bg-emerald-500" : "bg-border"
            )}
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4">
        <div className="flex items-center justify-between">
          <span className="font-medium">{step.stepName}</span>
          <Badge variant="outline" className="text-xs">
            {config.label}
          </Badge>
        </div>
        {step.duration !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            耗时: {formatDuration(step.duration)}
          </p>
        )}
        {step.tokenUsages && step.tokenUsages.length > 0 && (
          <TokenUsageDisplay
            usages={step.tokenUsages}
            isRunning={isRunning}
            maxVisible={2}
          />
        )}
        {step.error && (
          <p className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {step.error}
          </p>
        )}
      </div>
    </div>
  )
}

function ExecutionSteps({ steps }: { steps: StepExecution[] }) {
  return (
    <div className="space-y-0">
      {steps.map((step, index) => (
        <StepItem key={step.stepId} step={step} isLast={index === steps.length - 1} />
      ))}
    </div>
  )
}

function ExecutionLogs({ logs }: { logs: string[] }) {
  if (logs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无日志
      </div>
    )
  }

  return (
    <div className="font-mono text-xs">
      {logs.map((log, index) => (
        <div key={index} className="px-2 py-0.5 hover:bg-muted">
          {log}
        </div>
      ))}
    </div>
  )
}

export function ExecutionPanel({ execution, workspaceId, onStop, onRollback, onRefresh }: ExecutionPanelProps) {
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [retryInterventionDialog, setRetryInterventionDialog] = useState(false)
  const [retryInterventionLoading, setRetryInterventionLoading] = useState(false)

  // Track last shown approval to avoid re-opening on every poll cycle
  const approvalShownRef = useRef<string | null>(null)
  useEffect(() => {
    if (execution?.status === "pending_approval" && execution.approvalMetadata) {
      if (approvalShownRef.current !== execution.approvalMetadata.nodeId) {
        approvalShownRef.current = execution.approvalMetadata.nodeId
        setApprovalOpen(true)
      }
    } else if (execution?.status !== "pending_approval") {
      approvalShownRef.current = null
    }
  }, [execution?.status, execution?.approvalMetadata?.nodeId])

  if (!execution) {
    return (
      <div className="flex h-full flex-col border-l border-border bg-sidebar">
        <div className="flex h-10 items-center border-b border-border px-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            执行状态
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Play className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-4 font-medium">无执行任务</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            选择一个工作流开始执行
          </p>
          <Button className="mt-4" size="sm">
            <Play className="mr-2 h-4 w-4" />
            执行工作流
          </Button>
        </div>
      </div>
    )
  }

  const isRunning = execution.status === "running"
  const isPaused = execution.status === "paused"
  const isPendingApproval = execution.status === "pending_approval"
  const isFailed = execution.status === "failed"
  const isPending = execution.status === "pending"
  const isCancelled = execution.status === "cancelled"
  const showCancel = isRunning || isPaused
  const showRetry = isFailed
  const showExecute = isPending
  const showSkip = ["pending", "failed", "cancelled"].includes(execution.status)
  const showDelete = isPending || isCancelled

  const handleStart = async () => {
    if (!workspaceId) return
    await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/start`, { method: "POST" })
    onRefresh?.()
  }

  const handleCancel = async () => {
    if (!workspaceId) return
    await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/cancel`, { method: "POST" })
    onRefresh?.()
  }

  const handleRetry = async (intervention: string) => {
    if (!workspaceId) return
    setRetryInterventionLoading(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ failedNodeId: "", intervention }),
      })
      setRetryInterventionDialog(false)
      onRefresh?.()
    } catch (err) {
      console.error("Failed to retry", err)
    } finally {
      setRetryInterventionLoading(false)
    }
  }

  const handleSkip = async () => {
    if (!workspaceId) return
    await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/skip`, { method: "POST" })
    onRefresh?.()
  }

  const resumeExecution = async () => {
    if (!execution?.id || !workspaceId) return
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/resume`, { method: "POST" })
      onRefresh?.()
    } catch (err) {
      console.error("Failed to resume", err)
    }
  }

  const handleDelete = async () => {
    if (!workspaceId) return
    await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}`, { method: "DELETE" })
    onRefresh?.()
  }

  const handleApprove = async (value: string, comment: string) => {
    if (!workspaceId || !execution?.approvalMetadata) return

    setLoading(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: execution.approvalMetadata.nodeId,
          answer: value,
          comment
        }),
      })
      setApprovalOpen(false)
      onRefresh?.()
    } catch (err) {
      console.error("Approval failed:", err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-sidebar">
      {/* Approval Dialog */}
      {execution?.approvalMetadata && (
        <ApprovalDialog
          open={approvalOpen}
          onOpenChange={setApprovalOpen}
          approval={execution.approvalMetadata}
          onSubmit={handleApprove}
          loading={loading}
          storageKey={`octopus:ws:${workspaceId}:approval:${execution.id}`}
        />
      )}

      {/* Retry Intervention Dialog */}
      <InterventionDialog
        open={retryInterventionDialog}
        onOpenChange={(open) => { if (!open) setRetryInterventionDialog(false) }}
        onSubmit={handleRetry}
        loading={retryInterventionLoading}
        mode="retry"
        storageKey={`octopus:ws:${workspaceId}:intervention:retry:${execution.id}`}
      />

      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          执行状态
        </span>
        <div className="flex items-center gap-1">
          {showCancel && (
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={handleCancel}>
              <StopCircle className="h-3.5 w-3.5" />
              <span className="sr-only">取消</span>
            </Button>
          )}
          {showRetry && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setRetryInterventionDialog(true)}>
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="sr-only">重试</span>
            </Button>
          )}
          {showDelete && (
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="sr-only">删除</span>
            </Button>
          )}
        </div>
      </div>

      {/* Workflow Info */}
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2">
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{execution.workflowName}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Badge
            variant={
              execution.status === "completed"
                ? "default"
                : execution.status === "completed_with_failures"
                  ? "default"
                  : execution.status === "failed"
                    ? "destructive"
                    : execution.status === "paused"
                      ? "secondary"
                      : execution.status === "pending_approval"
                        ? "secondary"
                        : "secondary"
            }
          >
            {execution.status === "completed" && "完成"}
            {execution.status === "completed_with_failures" && "部分失败"}
            {execution.status === "failed" && "失败"}
            {execution.status === "running" && "运行中"}
            {execution.status === "pending" && "待开始"}
            {execution.status === "cancelled" && "已取消"}
            {execution.status === "pending_approval" && "待审批"}
            {execution.status === "paused" && (execution.approvalMetadata ? "待审批" : "已暂停")}
          </Badge>
          {execution.currentStep && (
            <span className="text-xs text-muted-foreground">
              当前: {execution.currentStep}
            </span>
          )}
        </div>
        {isRunning && (
          <div className="mt-3 flex items-center gap-2">
            <Progress value={execution.progress} className="h-1.5 flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {execution.progress}%
            </span>
          </div>
        )}
        {showExecute && (
          <Button className="mt-3 w-full" size="sm" onClick={handleStart}>
            <Play className="mr-2 h-4 w-4" />
            执行
          </Button>
        )}
        {showSkip && (
          <Button className="mt-2 w-full" variant="outline" size="sm" onClick={handleSkip}>
            <SkipForward className="mr-2 h-4 w-4" />
            跳过
          </Button>
        )}
      </div>

      {/* Inline Approval Prompt */}
      {isPendingApproval && execution.approvalMetadata && (
        <div className="flex items-center gap-2 border-b border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5">
          <ShieldCheck className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-sm text-amber-800 dark:text-amber-200">工作流已暂停，等待审批确认</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setApprovalOpen(true)}
            className="ml-auto h-6 text-xs border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            打开审批
          </Button>
        </div>
      )}

      {/* Paused state resume prompt */}
      {isPaused && !execution.approvalMetadata && (
        <div className="border-b border-border bg-violet-50 dark:bg-violet-950/20 p-3">
          <div className="flex items-center gap-2">
            <PauseCircle className="text-violet-500" size={16} />
            <span className="text-sm text-violet-700">执行已暂停，可点击继续恢复运行</span>
            <button
              onClick={() => resumeExecution()}
              className="ml-auto px-3 py-1 rounded bg-violet-600 text-white text-sm hover:bg-violet-700"
            >
              继续
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="steps" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="mx-3 mt-2 w-fit">
          <TabsTrigger value="steps" className="text-xs">
            步骤
          </TabsTrigger>
          <TabsTrigger value="logs" className="text-xs">
            <Terminal className="mr-1 h-3 w-3" />
            日志
          </TabsTrigger>
        </TabsList>
        <TabsContent value="steps" className="mt-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full p-3">
            <ExecutionSteps steps={execution.steps ?? []} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="logs" className="mt-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full bg-muted/50 p-2">
            <ExecutionLogs logs={execution.logs ?? []} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}