"use client"

import { memo, useCallback } from "react"
import type { NodeProps } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Network, Users, Gauge, CheckCircle2, XCircle, Loader2, Timer } from "lucide-react"
import { SwarmBadge } from "../atoms/swarm-badge"
import { formatDuration } from "@/lib/format"
import type { SwarmMode, SwarmStatus } from "@/lib/swarm-types"
import type { TokenUsage } from "@/lib/types"
import { TokenUsageDisplay } from "@/components/workspace/workflow-nodes/token-usage-display"

const statusBadgeConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  completed: { label: "已完成", color: "text-emerald-600", icon: CheckCircle2 },
  failed: { label: "失败", color: "text-red-600", icon: XCircle },
  running: { label: "运行中", color: "text-amber-600", icon: Loader2 },
}

export interface SwarmNodeData {
  id: string
  name: string
  mode: SwarmMode
  status: SwarmStatus
  expertCount: number
  consensusScore: number | null
  workspaceId: string
  executionId?: string
  statusOverlay?: { stepStatus?: string; duration?: number; tokenUsages?: TokenUsage[] }
  [key: string]: unknown
}

function SwarmNodeInner({ data: rawData }: NodeProps) {
  const data = rawData as unknown as SwarmNodeData

  // Use execution status from overlay when available, fallback to static YAML status
  const effectiveStatus = (data.statusOverlay?.stepStatus as SwarmStatus) ?? data.status ?? "pending"
  const isRunning = effectiveStatus === "running" || effectiveStatus === "initializing"
  const isCompleted = effectiveStatus === "completed"
  const isFailed = effectiveStatus === "failed"

  return (
    <>
      <div
        data-node-type="swarm"
        data-swarm-mode={data.mode}
        className={cn(
          "rounded-[calc(var(--radius)-2px)] bg-card shadow-sm cursor-pointer",
          "transition-all duration-200 hover:shadow-md",
          "border-2 min-w-[260px] max-w-[300px]",
          isRunning && "border-cyan-300 dark:border-cyan-700 animate-swarm-pulse",
          isCompleted && "border-emerald-200 dark:border-emerald-800",
          isFailed && "border-red-200 dark:border-red-800",
          !isRunning && !isCompleted && !isFailed && "border-cyan-200 dark:border-cyan-800",
        )}
      >
        <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />

        {/* Header */}
        <div className="flex items-center gap-2 rounded-t-md px-3 py-2 bg-cyan-50 dark:bg-cyan-950/30">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-card">
            <Network className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="truncate text-sm font-medium">{data.name || "Swarm"}</h4>
          </div>
          {data.mode && <SwarmBadge mode={data.mode} size="sm" />}
          {statusBadgeConfig[effectiveStatus] && (() => {
            const cfg = statusBadgeConfig[effectiveStatus]
            const Icon = cfg.icon
            return (
              <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 ml-1", cfg.color)}>
                <Icon className={cn("h-3 w-3 mr-0.5", effectiveStatus === "running" && "animate-spin")} />
                {cfg.label}
              </Badge>
            )
          })()}
        </div>

        {/* Body */}
        <div className="px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              <span>{data.expertCount ?? 0} 专家</span>
            </div>
            {data.consensusScore != null && (
              <div className="flex items-center gap-1">
                <Gauge className="h-3 w-3" />
                <span className="tabular-nums">{data.consensusScore.toFixed(2)}</span>
              </div>
            )}
          </div>

          {isRunning && (
            <div className="h-1 bg-muted rounded-full overflow-hidden">
              <div className="h-full w-full bg-cyan-400 rounded-full animate-pulse" />
            </div>
          )}

          {isCompleted && data.statusOverlay?.duration != null && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Timer className="h-3 w-3" />
              <span>耗时: {formatDuration(data.statusOverlay.duration)}</span>
            </div>
          )}

          {data.statusOverlay?.tokenUsages && data.statusOverlay.tokenUsages.length > 0 && (
            <TokenUsageDisplay
              usages={data.statusOverlay.tokenUsages}
              isRunning={isRunning}
              maxVisible={2}
            />
          )}
        </div>

        <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
      </div>
    </>
  )
}

export const SwarmNode = memo(SwarmNodeInner)
