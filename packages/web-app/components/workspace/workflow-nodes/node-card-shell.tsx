"use client"

import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { nodeIconConfigs, type NodeIconConfig } from "./node-icon-config"
import type { StatusOverlay, StepExecutionStatus } from "@/lib/types"
import { formatDuration } from "@/lib/format"
import { useLiveTimer } from "@/hooks/use-live-timer"
import { Clock, Loader2, CheckCircle2, XCircle, SkipForward, PauseCircle, Timer, Ban } from "lucide-react"

interface NodeCardShellProps {
  id: string
  nodeType: string
  name: string
  config?: NodeIconConfig
  children?: React.ReactNode
  selected?: boolean
  extraHandles?: React.ReactNode
  statusOverlay?: StatusOverlay
  isCurrent?: boolean
  isActive?: boolean
}

const statusVisualConfig: Record<StepExecutionStatus, { color: string; bgColor: string; borderColor: string; label: string; icon: React.ElementType }> = {
  pending: { color: "text-blue-600", bgColor: "bg-blue-50", borderColor: "border-blue-200", label: "待开始", icon: Clock },
  running: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-300", label: "运行中", icon: Loader2 },
  completed: { color: "text-emerald-600", bgColor: "bg-emerald-50", borderColor: "border-emerald-200", label: "已完成", icon: CheckCircle2 },
  failed: { color: "text-red-600", bgColor: "bg-red-50", borderColor: "border-red-200", label: "失败", icon: XCircle },
  skipped: { color: "text-gray-600", bgColor: "bg-gray-50", borderColor: "border-gray-200", label: "跳过", icon: SkipForward },
  cancelled: { color: "text-gray-500", bgColor: "bg-gray-50", borderColor: "border-gray-200", label: "已取消", icon: XCircle },
  paused: { color: "text-violet-600", bgColor: "bg-violet-50", borderColor: "border-violet-200", label: "已暂停", icon: PauseCircle },
  rejected: { color: "text-orange-600", bgColor: "bg-orange-50", borderColor: "border-orange-200", label: "已拒绝", icon: Ban },
  pending_approval: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-300", label: "待审批", icon: PauseCircle },
}

export function NodeCardShell({
  id,
  nodeType,
  name,
  config,
  children,
  selected = false,
  extraHandles,
  statusOverlay,
  isCurrent = false,
  isActive = false,
}: NodeCardShellProps) {
  const resolvedConfig = config || nodeIconConfigs[nodeType]
  const Icon = resolvedConfig.icon
  const statusConfig = statusOverlay ? statusVisualConfig[statusOverlay.stepStatus] : null
  const effectiveBorderColor = statusConfig ? statusConfig.borderColor : resolvedConfig.borderColor
  const isRunning = statusOverlay?.stepStatus === "running"
  const elapsedSeconds = useLiveTimer(isRunning ? statusOverlay?.startedAt : undefined)

  return (
    <div
      className={cn(
        "rounded-lg border-2 bg-card transition-all shadow-sm hover:shadow-md w-[280px]",
        effectiveBorderColor,
        selected && "ring-2 ring-primary ring-offset-2",
        isCurrent && "animate-pulse border-amber-400 shadow-amber-100",
        isActive && "ring-2 ring-primary ring-offset-2",
        statusOverlay?.stepStatus === "skipped" && "opacity-70"
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />

      {extraHandles}

      <div className={cn("flex items-center gap-2 rounded-t-md px-3 py-2", resolvedConfig.bgColor)}>
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-card">
          <Icon className={cn("h-4 w-4", resolvedConfig.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="truncate text-sm font-medium">{name}</h4>
        </div>
        <Badge variant="outline" className={cn("text-xs", resolvedConfig.color)}>
          {resolvedConfig.label}
        </Badge>
        {statusConfig && (
          <Badge variant="outline" className={cn("text-xs ml-1", statusConfig.color)}>
            {statusConfig.label}
          </Badge>
        )}
      </div>

      <div className="p-3">
        {children || <p className="text-xs text-muted-foreground truncate">{id}</p>}
        {statusOverlay && statusOverlay.stepStatus === "running" && (
          <div className="h-1 bg-muted mt-2">
            <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: "0%" }} />
          </div>
        )}
        {isRunning && elapsedSeconds !== undefined && (
          <div className="flex items-center justify-between text-xs text-amber-600 font-medium mt-2">
            <span className="tabular-nums"><Timer className="h-3 w-3 inline mr-1" />{formatDuration(elapsedSeconds)}</span>
          </div>
        )}
        {statusOverlay && statusOverlay.stepStatus === "completed" && statusOverlay.duration !== undefined && (
          <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
            <span className="tabular-nums">耗时: {formatDuration(statusOverlay.duration)}</span>
          </div>
        )}
        {statusOverlay && statusOverlay.stepStatus === "failed" && statusOverlay.error && (
          <p className="mt-2 text-xs text-red-600 truncate">{statusOverlay.error}</p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )
}