"use client"

import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { nodeIconConfigs } from "./node-icon-config"
import type { StatusOverlay, StepExecutionStatus } from "@/lib/types"

interface StatusShellProps {
  nodeType: string
  statusOverlay?: StatusOverlay
  isCurrent?: boolean
  isActive?: boolean
  selected?: boolean
  extraHandles?: React.ReactNode
  children: React.ReactNode
}

const borderConfig: Record<StepExecutionStatus, string> = {
  pending: "border-blue-200",
  running: "border-amber-300",
  completed: "border-emerald-200",
  failed: "border-red-200",
  skipped: "border-gray-200",
  cancelled: "border-gray-200",
  paused: "border-violet-300",
  rejected: "border-orange-300",
  pending_approval: "border-amber-300",
}

export function StatusShell({
  nodeType,
  statusOverlay,
  isCurrent = false,
  isActive = false,
  selected = false,
  extraHandles,
  children,
}: StatusShellProps) {
  const typeConfig = nodeIconConfigs[nodeType]
  const effectiveBorderColor = statusOverlay ? borderConfig[statusOverlay.stepStatus] : typeConfig.borderColor
  const isHarnessActive = statusOverlay?.harnessStatus === "harness_intervening"
    || statusOverlay?.harnessStatus === "harness_modified"
  const marchColor = statusOverlay?.harnessStatus === "harness_intervening" ? "#8b5cf6" : "#f59e0b"
  const isDone = statusOverlay?.stepStatus === "completed"
    || statusOverlay?.stepStatus === "failed"
    || statusOverlay?.stepStatus === "rejected"
    || statusOverlay?.stepStatus === "skipped"
    || statusOverlay?.stepStatus === "cancelled"
  const showMarchingAnts = isHarnessActive || (!isDone && statusOverlay?.stepStatus === "running")

  return (
    <div
      className={cn(
        "rounded-lg border-2 bg-card transition-all shadow-sm hover:shadow-md w-[280px] overflow-hidden",
        effectiveBorderColor,
        selected && "ring-2 ring-primary ring-offset-2",
        statusOverlay?.stepStatus === "running" && "border-running",
        statusOverlay?.stepStatus === "skipped" && "opacity-70",
        statusOverlay?.stepStatus === "cancelled" && "opacity-60",
        statusOverlay?.stepStatus === "paused" && "animate-pulse shadow-violet-100",
        statusOverlay?.stepStatus === "pending_approval" && "animate-pulse shadow-amber-100",
      )}
      style={showMarchingAnts ? {
        borderColor: "transparent",
        background: `
          repeating-linear-gradient(90deg, ${marchColor} 0 6px, transparent 6px 12px) top    / 100% 2px no-repeat,
          repeating-linear-gradient(90deg, ${marchColor} 0 6px, transparent 6px 12px) bottom / 100% 2px no-repeat,
          repeating-linear-gradient(0deg, ${marchColor} 0 6px, transparent 6px 12px) left   / 2px 100% no-repeat,
          repeating-linear-gradient(0deg, ${marchColor} 0 6px, transparent 6px 12px) right  / 2px 100% no-repeat`,
        animation: "border-march 0.6s linear infinite",
      } : undefined}
    >
      <style>{`
        @keyframes border-march {
          to {
            background-position:
              -12px 0,
              -12px 100%,
              0 -12px,
              100% -12px;
          }
        }
      `}</style>
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      {extraHandles}
      {children}
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )
}