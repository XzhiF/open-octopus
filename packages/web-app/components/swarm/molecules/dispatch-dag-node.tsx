"use client"

import { cn } from "@/lib/utils"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { StatusDot } from "../atoms/status-dot"
import type { ExpertStatus } from "@/lib/swarm-types"

export interface DispatchDagNodeData {
  role: string
  status: ExpertStatus
  level: number
  [key: string]: unknown
}

export function DispatchDagNode({ data }: NodeProps) {
  const { role, status, level } = data as unknown as DispatchDagNodeData

  const statusBorderMap: Record<ExpertStatus, string> = {
    running: "border-swarm-expert-running",
    completed: "border-swarm-expert-completed",
    failed: "border-swarm-expert-failed",
    skipped: "border-swarm-expert-skipped",
    budget_exceeded: "border-swarm-expert-budget-exceeded",
    pending: "border-border",
  }

  return (
    <div
      className={cn(
        "rounded-md border-2 bg-card px-3 py-2 min-w-[140px] max-w-[180px] shadow-sm",
        statusBorderMap[status],
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5" />

      <div className="flex items-center gap-2">
        <StatusDot status={status} pulse={status === "running"} size="sm" />
        <span className="text-xs font-medium truncate flex-1">{role}</span>
      </div>

      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] text-muted-foreground">Level {level}</span>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5" />
    </div>
  )
}
