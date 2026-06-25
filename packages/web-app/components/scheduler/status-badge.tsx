"use client"

import { CheckCircle2, PauseCircle, AlertCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface StatusBadgeProps {
  enabled: boolean
  lastExecutionStatus?: string
  consecutiveFailures?: number
}

export function StatusBadge({
  enabled,
  lastExecutionStatus,
  consecutiveFailures = 0,
}: StatusBadgeProps) {
  const isFailed = consecutiveFailures > 0

  if (isFailed) {
    const content = (
      <Badge
        className={cn(
          "bg-scheduler-error/15 text-scheduler-error border-scheduler-error/30"
        )}
        aria-label={`失败，连续 ${consecutiveFailures} 次`}
      >
        <AlertCircle className="size-3" />
        失败
      </Badge>
    )

    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent>
          <p>连续失败 {consecutiveFailures} 次</p>
          {lastExecutionStatus && (
            <p className="text-xs opacity-75">
              上次状态: {lastExecutionStatus}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (!enabled) {
    return (
      <Badge
        className={cn(
          "bg-scheduler-paused/15 text-scheduler-paused border-scheduler-paused/30"
        )}
        aria-label="已暂停"
      >
        <PauseCircle className="size-3" />
        已暂停
      </Badge>
    )
  }

  return (
    <Badge
      className={cn(
        "bg-scheduler-success/15 text-scheduler-success border-scheduler-success/30"
      )}
      aria-label="已启用"
    >
      <CheckCircle2 className="size-3" />
      已启用
    </Badge>
  )
}
