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
    >
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
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      {extraHandles}
      {children}
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )
}