"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { nodeIconConfigs } from "./node-icon-config"
import type { StatusOverlay, StepExecutionStatus, HarnessNodeStatus } from "@/lib/types"
import { formatDuration } from "@/lib/format"
import { TokenAggregateLine } from "./token-aggregate-line"
import { useLiveTimer } from "@/hooks/use-live-timer"
import { Clock, Loader2, CheckCircle2, XCircle, SkipForward, PauseCircle, Timer, ShieldCheck, ShieldX, Bot } from "lucide-react"

interface TypeShellProps {
  nodeType: string
  name: string
  statusOverlay?: StatusOverlay
  children?: React.ReactNode
}

const statusVisualConfig: Record<StepExecutionStatus, { color: string; bgColor: string; borderColor: string; label: string }> = {
  pending: { color: "text-pop-cyan", bgColor: "bg-pop-cyan-soft", borderColor: "border-pop-cyan/40", label: "待开始" },
  running: { color: "text-pop-ink", bgColor: "bg-pop-amber-soft", borderColor: "border-pop-amber/40", label: "运行中" },
  completed: { color: "text-pop-green", bgColor: "bg-pop-green-soft", borderColor: "border-pop-green/40", label: "已完成" },
  failed: { color: "text-pop-red", bgColor: "bg-pop-pink-soft", borderColor: "border-pop-red/40", label: "失败" },
  skipped: { color: "text-pop-dim", bgColor: "bg-pop-idle", borderColor: "border-pop-bd/30", label: "跳过" },
  cancelled: { color: "text-pop-dim", bgColor: "bg-pop-idle", borderColor: "border-pop-bd/30", label: "已取消" },
  paused: { color: "text-pop-purple", bgColor: "bg-pop-purple-soft", borderColor: "border-pop-purple/40", label: "已暂停" },
  rejected: { color: "text-pop-ink", bgColor: "bg-pop-amber-soft", borderColor: "border-pop-amber/40", label: "已拒绝" },
  pending_approval: { color: "text-pop-ink", bgColor: "bg-pop-amber-soft", borderColor: "border-pop-amber/40", label: "待审批" },
  pending_interaction: { color: "text-pop-purple", bgColor: "bg-pop-purple-soft", borderColor: "border-pop-purple/40", label: "交互中" },
}

const typeTints: Record<string, string> = {
  bash: "var(--pop-green-soft)",
  python: "var(--pop-cyan-soft)",
  agent: "var(--pop-purple-soft)",
  condition: "var(--pop-amber-soft)",
  approval: "var(--pop-green-soft)",
  interaction: "var(--pop-purple-soft)",
  loop: "var(--pop-amber-soft)",
  octopus_agent: "var(--pop-pink-soft)",
}

function HarnessBadge({ status }: { status: HarnessNodeStatus }) {
  switch (status) {
    case "harness_intervening":
      return (
        <span title="Harness 正在干预" className="inline-flex items-center ml-1 animate-pulse">
          <span className="text-sm leading-none">🛡️</span>
        </span>
      )
    case "harness_modified":
      return (
        <span title="Harness 已修改" className="inline-flex items-center gap-0.5 ml-1">
          <span className="text-sm leading-none">🛡️</span>
          <CheckCircle2 className="h-2.5 w-2.5 text-pop-green" />
        </span>
      )
    case "harness_executed":
      return (
        <span title="Harness Agent 接管" className="inline-flex items-center ml-1">
          <span className="text-sm leading-none">🤖</span>
        </span>
      )
    case "harness_blocked":
      return (
        <span title="Harness 已阻断" className="inline-flex items-center gap-0.5 ml-1">
          <span className="text-sm leading-none">🛡️</span>
          <XCircle className="h-2.5 w-2.5 text-pop-red" />
        </span>
      )
    default:
      return null
  }
}

export function TypeShell({ nodeType, name, statusOverlay, children }: TypeShellProps) {
  const config = nodeIconConfigs[nodeType]
  const Icon = config.icon
  const tint = typeTints[nodeType] || "var(--pop-idle)"
  const statusConfig = statusOverlay ? statusVisualConfig[statusOverlay.stepStatus] : null
  const isRunning = statusOverlay?.stepStatus === "running"
  const elapsedSeconds = useLiveTimer(isRunning ? statusOverlay?.startedAt : undefined)

  return (
    <>
      <div className="flex items-center gap-2 rounded-t-md px-3 py-2" style={{ backgroundColor: tint }}>
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-pop-paper">
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
        {statusOverlay?.harnessStatus && (
          <HarnessBadge status={statusOverlay.harnessStatus} />
        )}
      </div>
      {children && <div className="p-3">{children}</div>}
      {statusOverlay?.stepStatus === "running" && (
        <div className="h-1 bg-muted">
          <div className="h-full bg-pop-amber transition-all duration-500" style={{ width: "0%" }} />
        </div>
      )}
      {isRunning && elapsedSeconds !== undefined && (
        <div className="flex items-center justify-between text-xs text-pop-ink font-medium px-3 pb-1">
          <span className="tabular-nums"><Timer className="h-3 w-3 inline mr-1" />{formatDuration(elapsedSeconds * 1000)}</span>
        </div>
      )}
      {statusOverlay?.stepStatus === "completed" && statusOverlay.duration !== undefined && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-3 pb-1">
          <span className="tabular-nums">耗时: {formatDuration((statusOverlay.duration ?? 0) * 1000)}</span>
        </div>
      )}
      {/* 节点主行：模型 · ∑处理量(含缓存) · N次 · 费用。缓存/每模型明细收进点开弹窗。 */}
      <TokenAggregateLine usage={statusOverlay?.tokenUsage} requestCount={statusOverlay?.requestCount} isRunning={isRunning} className="px-3 pb-1" />
      {statusOverlay?.stepStatus === "failed" && statusOverlay.error && (
        <p className="px-3 pb-1 text-xs text-pop-red truncate">{statusOverlay.error}</p>
      )}
    </>
  )
}