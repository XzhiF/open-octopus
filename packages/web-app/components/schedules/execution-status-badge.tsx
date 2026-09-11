"use client"

import { Badge } from "@/components/ui/badge"
import type { ScheduleExecution } from "@/lib/types"

interface Props {
  status: ScheduleExecution["status"]
}

const STATUS_CONFIG: Record<
  ScheduleExecution["status"],
  { label: string; variant?: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
  triggered: { label: "Triggered", variant: "default" },
  running: { label: "Running", variant: "default", className: "animate-pulse" },
  completed: { label: "Completed", className: "bg-pop-green-soft text-pop-green border-pop-green/40" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Skipped", variant: "secondary" },
  missed: { label: "Missed", className: "bg-pop-yellow-soft text-pop-amber border-pop-yellow/40" },
}

export function ExecutionStatusBadge({ status }: Props) {
  const config = STATUS_CONFIG[status]
  return (
    <Badge variant={config.variant} className={config.className}>
      {config.label}
    </Badge>
  )
}
