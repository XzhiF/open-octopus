"use client"

import { cn } from "@/lib/utils"
import type { ExpertStatus } from "@/lib/swarm-types"

export interface StatusDotProps {
  status: ExpertStatus
  pulse?: boolean
  size?: "sm" | "md"
}

const statusColorMap: Record<ExpertStatus, string> = {
  running: "bg-swarm-expert-running",
  completed: "bg-swarm-expert-completed",
  failed: "bg-swarm-expert-failed",
  skipped: "bg-swarm-expert-skipped",
  budget_exceeded: "bg-swarm-expert-budget-exceeded",
  pending: "bg-muted-foreground/40",
}

const sizeMap = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
}

export function StatusDot({ status, pulse = false, size = "sm" }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block rounded-full",
        statusColorMap[status],
        sizeMap[size],
        pulse && "animate-swarm-pulse",
      )}
      aria-label={status}
    />
  )
}
