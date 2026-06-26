"use client"

import { memo } from "react"
import type { NodeProps } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { ExecutionButtonBar } from "./execution-button-bar"
import { useExecutionNodeCallbacks } from "./execution-node-context"
import type { ExecutionNodeData, ExecutionStatus, GateStatus } from "@/lib/types"
import { CheckCircle2, XCircle, Clock, Loader2, SkipForward, ShieldOff, Undo2, PauseCircle, PlayCircle, Timer, Webhook, MessageSquare, Hourglass, Ban } from "lucide-react"
import { formatDuration } from "@/lib/format"
import { useLiveTimer } from "@/hooks/use-live-timer"
import { TokenUsageDisplay } from "./token-usage-display"
import { CostLine } from "@/components/cost-line"

const statusConfig: Record<ExecutionStatus, { color: string; bgColor: string; borderColor: string; label: string }> = {
  pending: { color: "text-blue-600", bgColor: "bg-blue-50", borderColor: "border-blue-200", label: "待开始" },
  running: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-300", label: "运行中" },
  completed: { color: "text-emerald-600", bgColor: "bg-emerald-50", borderColor: "border-emerald-200", label: "已完成" },
  completed_with_failures: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-300", label: "部分失败" },
  failed: { color: "text-red-600", bgColor: "bg-red-50", borderColor: "border-red-200", label: "失败" },
  cancelled: { color: "text-gray-600", bgColor: "bg-gray-50", borderColor: "border-gray-200", label: "已取消" },
  paused: { color: "text-violet-600", bgColor: "bg-violet-50", borderColor: "border-violet-200", label: "已暂停" },
  pending_approval: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-200", label: "待审批" },
  pending_resume: { color: "text-blue-600", bgColor: "bg-blue-50", borderColor: "border-blue-200", label: "待恢复" },
  skipped: { color: "text-gray-400", bgColor: "bg-gray-50", borderColor: "border-gray-200", label: "已跳过" },
  rejected: { color: "text-orange-600", bgColor: "bg-orange-50", borderColor: "border-orange-200", label: "已拒绝" },
}

const gateLabelMap: Record<GateStatus, string> = {
  open: "",
  closed: "",
  bypassed: "(已绕过)",
}

function triggeredByLabel(triggeredBy: string): string {
  switch (triggeredBy) {
    case "schedule": return "定时"
    case "webhook": return "webhook"
    case "chat": return "chat"
    default: return triggeredBy
  }
}

function ExecutionNodeInner({ data: rawData, selected }: NodeProps) {
  const data = rawData as unknown as ExecutionNodeData
  const callbacks = useExecutionNodeCallbacks()
  const nodeId = data.id
  const config = statusConfig[data.executionStatus] ?? statusConfig.pending
  const isRoot = data.parentId === "0" || data.parentId === null
  const displayLabel = isRoot && data.executionStatus === "pending"
    ? "待开始"
    : data.executionStatus === "pending_approval"
      ? "待审批"
      : data.executionStatus === "paused" && data.approvalMetadata
        ? "待审批"
        : config.label
  const isLast = data.isLastCompleted ?? false
  const badgeVariant = isLast ? "default" : "outline"
  const badgeLabel = isLast ? "最近完成" : displayLabel
  const badgeClasses = isLast ? "bg-emerald-600 text-white border-emerald-600" : config.color
  const isRunning = data.executionStatus === "running"
  const elapsedSeconds = useLiveTimer(isRunning ? data.startedAt : undefined)
  const showRollback = (data.executionStatus === "running" || data.executionStatus === "failed") && (data.rollbackOnError || data.rollback === "git-revert")
  const gateLabel = gateLabelMap[data.gateStatus]

  const card = (
    <div
      className={cn(
        "rounded-[calc(var(--radius)-2px)] bg-card shadow-sm hover:shadow-md",
        "transition-shadow duration-200",
        isRunning ? "" : "border-2 " + config.borderColor,
        "cursor-grab active:cursor-grabbing",
        data.gateStatus === "bypassed" && "opacity-70",
      )}
      data-status={data.executionStatus}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <div className={cn("flex items-center gap-2 rounded-t-md px-3 py-2", config.bgColor, isLast && "animate-shimmer-sweep relative overflow-hidden")}>
        {isLast && <div className="absolute inset-0 bg-gradient-to-r from-transparent via-emerald-200/30 to-transparent shimmer-overlay" />}
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-card">
          {isRunning ? <Loader2 className={cn("h-4 w-4 animate-spin", config.color)} />
          : data.executionStatus === "completed" ? <CheckCircle2 className={cn("h-4 w-4", config.color)} />
          : data.executionStatus === "failed" ? <XCircle className={cn("h-4 w-4", config.color)} />
          : data.executionStatus === "rejected" ? <Ban className={cn("h-4 w-4", config.color)} />
          : data.executionStatus === "pending" || data.executionStatus === "pending_resume" ? <Clock className={cn("h-4 w-4", config.color)} />
          : <SkipForward className={cn("h-4 w-4", config.color)} />}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="truncate text-sm font-medium">{data.name || data.workflowName}</h4>
        </div>
        <Badge variant={badgeVariant} className={cn("text-xs", badgeClasses)}>{badgeLabel}{gateLabel}</Badge>
        {data.gateStatus === "bypassed" && (
          <ShieldOff className="h-4 w-4 text-gray-400" />
        )}
      </div>
      {isRunning && (
        <div className="h-1 bg-muted">
          <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: `${data.progress}%` }} />
        </div>
      )}
      <div className="p-3">
        {data.executionStatus === "paused" && data.approvalMetadata && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-violet-50 px-2 py-1.5 text-xs text-violet-700 dark:bg-violet-950/20 dark:text-violet-300">
            <PauseCircle className="h-3.5 w-3.5" />
            <span className="font-medium truncate">{data.approvalMetadata.prompt}</span>
          </div>
        )}
        {data.branch && data.branchColor && (
          <div className="flex items-center gap-2 mb-1">
            <span className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium shrink-0 border",
              data.branchColor.bg, data.branchColor.text, data.branchColor.border
            )}>
              {data.branch}
            </span>
          </div>
        )}
        {isRunning && (!data.tokenUsages || data.tokenUsages.length === 0) && (
          <div className="h-4 mt-1" />
        )}
        {data.tokenUsages && data.tokenUsages.length > 0 && (
          <TokenUsageDisplay
            usages={data.tokenUsages}
            isRunning={isRunning}
          />
        )}
        {data.costUsd != null && data.costUsd > 0 && (
          <CostLine
            costUsd={data.costUsd}
            turns={data.turnCount}
            tools={data.toolCount}
            durationMs={data.duration != null ? data.duration * 1000 : undefined}
          />
        )}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5 min-w-0">
            {isRunning && <span className="tabular-nums shrink-0">{data.progress}%</span>}
            {showRollback && (
              <span className="flex items-center gap-1 text-orange-600" title="仅回滚工作区文件变更，数据库等外部变更需手动处理">
                <Undo2 className="h-3 w-3" />回滚: {data.rollbackOnError ? "git-reset+clean" : data.rollback}
              </span>
            )}
            {data.triggeredBy && data.triggeredBy !== "manual" && (
              <span className="flex items-center gap-1 shrink-0">
                {data.triggeredBy === "schedule" && <Timer className="h-3 w-3" />}
                {data.triggeredBy === "webhook" && <Webhook className="h-3 w-3" />}
                {data.triggeredBy === "chat" && <MessageSquare className="h-3 w-3" />}
                {triggeredByLabel(data.triggeredBy)}
              </span>
            )}
          </div>
          {isRunning && elapsedSeconds !== undefined && (
            <span className="flex items-center gap-1 shrink-0 tabular-nums text-amber-600 font-medium">
              <Timer className="h-3 w-3" />{formatDuration(elapsedSeconds)}
            </span>
          )}
          {!isRunning && (data.executionStatus === "completed" || data.executionStatus === "failed" || data.executionStatus === "cancelled" || data.executionStatus === "rejected") && data.duration !== undefined && (
            <span className="flex items-center gap-1 shrink-0 tabular-nums">
              <Hourglass className="h-3 w-3" />{formatDuration(data.duration)}
            </span>
          )}
        </div>
        <ExecutionButtonBar
          isLeaf={data.isLeaf}
          executionStatus={data.executionStatus}
          gateStatus={data.gateStatus}
          parentGateStatus={data.parentGateStatus}
          rollback={data.rollback}
          parentId={data.parentId}
          hasApproval={!!data.approvalMetadata}
          pausing={callbacks.isPausing?.(nodeId) ?? false}
          onDetail={() => callbacks.onDetail?.(nodeId)}
          onExecute={() => callbacks.onExecute?.(nodeId)}
          onRetry={() => callbacks.onRetry?.(nodeId)}
          onSkip={() => callbacks.onSkip?.(nodeId)}
          onTerminate={() => callbacks.onTerminate?.(nodeId)}
          onDelete={() => callbacks.onDelete?.(nodeId)}
          onApprove={() => callbacks.onApprove?.(nodeId)}
          onPause={() => callbacks.onPause?.(nodeId)}
          onResume={() => callbacks.onResume?.(nodeId)}
        />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )

  if (isRunning) {
    return (
      <div className="border-running rounded-lg p-0.5 min-w-[300px] max-w-[340px]">
        <style>{`
          @keyframes border-march {
            to {
              background-position:
                -12px 0,    /* top: dash flow right */
                -12px 100%, /* bottom: dash flow right */
                0 -12px,    /* left: dash flow down */
                100% -12px; /* right: dash flow down */
            }
          }
          .border-running {
            border-color: transparent;
            background:
              repeating-linear-gradient(90deg, #f59e0b 0 6px, transparent 6px 12px) top    / 100% 2px no-repeat,
              repeating-linear-gradient(90deg, #f59e0b 0 6px, transparent 6px 12px) bottom / 100% 2px no-repeat,
              repeating-linear-gradient(0deg, #f59e0b 0 6px, transparent 6px 12px) left   / 2px 100% no-repeat,
              repeating-linear-gradient(0deg, #f59e0b 0 6px, transparent 6px 12px) right  / 2px 100% no-repeat;
            animation: border-march 0.6s linear infinite;
          }
        `}</style>
        {card}
      </div>
    )
  }

  return (
    <div className="min-w-[300px] max-w-[340px]">
      {card}
    </div>
  )
}

export const ExecutionNode = memo(ExecutionNodeInner)
