"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { nodeIconConfigs } from "./node-icon-config"
import type { StatusOverlay, StepExecutionStatus } from "@/lib/types"
import { formatDuration } from "@/lib/format"
import { useLiveTimer } from "@/hooks/use-live-timer"
import { TokenUsageLine } from "./token-usage-line"
import { TokenUsageDisplay } from "./token-usage-display"
import { Clock, Loader2, CheckCircle2, XCircle, SkipForward, PauseCircle, Timer } from "lucide-react"

interface TypeShellProps {
  nodeType: string
  name: string
  statusOverlay?: StatusOverlay
  children?: React.ReactNode
}

const statusVisualConfig: Record<StepExecutionStatus, { color: string; bgColor: string; borderColor: string; label: string }> = {
  pending: { color: "text-blue-600", bgColor: "bg-blue-50", borderColor: "border-blue-200", label: "待开始" },
  running: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-300", label: "运行中" },
  completed: { color: "text-emerald-600", bgColor: "bg-emerald-50", borderColor: "border-emerald-200", label: "已完成" },
  failed: { color: "text-red-600", bgColor: "bg-red-50", borderColor: "border-red-200", label: "失败" },
  skipped: { color: "text-gray-600", bgColor: "bg-gray-50", borderColor: "border-gray-200", label: "跳过" },
  cancelled: { color: "text-gray-500", bgColor: "bg-gray-50", borderColor: "border-gray-200", label: "已取消" },
  paused: { color: "text-violet-600", bgColor: "bg-violet-50", borderColor: "border-violet-200", label: "已暂停" },
  rejected: { color: "text-orange-600", bgColor: "bg-orange-50", borderColor: "border-orange-200", label: "已拒绝" },
  pending_approval: { color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-300", label: "待审批" },
}

const typeTints: Record<string, string> = {
  bash: "rgba(34,197,94,0.08)",
  python: "rgba(59,130,246,0.08)",
  agent: "rgba(168,85,247,0.08)",
  condition: "rgba(245,158,11,0.08)",
  approval: "rgba(16,185,129,0.08)",
  loop: "rgba(249,115,22,0.08)",
}

export function TypeShell({ nodeType, name, statusOverlay, children }: TypeShellProps) {
  const config = nodeIconConfigs[nodeType]
  const Icon = config.icon
  const tint = typeTints[nodeType] || "rgba(107,114,128,0.08)"
  const statusConfig = statusOverlay ? statusVisualConfig[statusOverlay.stepStatus] : null
  const isRunning = statusOverlay?.stepStatus === "running"
  const elapsedSeconds = useLiveTimer(isRunning ? statusOverlay?.startedAt : undefined)

  return (
    <>
      <div className="flex items-center gap-2 rounded-t-md px-3 py-2" style={{ backgroundColor: tint }}>
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-card">
          <Icon className={cn("h-4 w-4", config.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="truncate text-sm font-medium">{name}</h4>
        </div>
        <Badge variant="outline" className="text-xs border-border text-muted-foreground bg-transparent">
          {config.label}
        </Badge>
        {statusConfig && (
          <Badge variant="outline" className={cn("text-xs ml-1", statusConfig.color)}>
            {statusConfig.label}
          </Badge>
        )}
      </div>
      {children && <div className="p-3">{children}</div>}
      {statusOverlay?.stepStatus === "running" && (
        <div className="h-1 bg-muted">
          <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: "0%" }} />
        </div>
      )}
      {isRunning && elapsedSeconds !== undefined && (
        <div className="flex items-center justify-between text-xs text-amber-600 font-medium px-3 pb-1">
          <span className="tabular-nums"><Timer className="h-3 w-3 inline mr-1" />{formatDuration(elapsedSeconds)}</span>
        </div>
      )}
      {statusOverlay?.stepStatus === "completed" && statusOverlay.duration !== undefined && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-3 pb-1">
          <span className="tabular-nums">耗时: {formatDuration(statusOverlay.duration)}</span>
        </div>
      )}
      {/* Token usage display */}
      {statusOverlay?.tokenUsages && statusOverlay.tokenUsages.length > 0 ? (
        <div className="px-3 pb-1">
          <TokenUsageDisplay
            usages={statusOverlay.tokenUsages}
            isRunning={isRunning}
            maxVisible={2}
          />
        </div>
      ) : (
        <TokenUsageLine
          usage={statusOverlay?.tokenUsage}
          isRunning={isRunning}
        />
      )}
      {statusOverlay?.stepStatus === "failed" && statusOverlay.error && (
        <p className="px-3 pb-1 text-xs text-red-600 truncate">{statusOverlay.error}</p>
      )}
    </>
  )
}