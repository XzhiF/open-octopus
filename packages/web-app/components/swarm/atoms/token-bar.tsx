"use client"

import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"

export interface TokenBarProps {
  consumed: number
  inputTokens?: number
  outputTokens?: number
  max?: number
  showLabel?: boolean
}

export function TokenBar({ consumed, inputTokens, outputTokens, max, showLabel = false }: TokenBarProps) {
  const percentage = max ? Math.min((consumed / max) * 100, 100) : null
  const isWarning = percentage != null && percentage >= 90
  const hasBreakdown = inputTokens != null && outputTokens != null && (inputTokens > 0 || outputTokens > 0)

  return (
    <div className="flex items-center gap-2">
      {max ? (
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden min-w-[40px]">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              isWarning ? "bg-swarm-budget-warning" : "bg-swarm-primary",
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      ) : (
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden min-w-[40px]">
          <div className="h-full w-full rounded-full bg-swarm-primary/30" />
        </div>
      )}
      {showLabel && (
        <span className={cn(
          "text-[10px] tabular-nums shrink-0",
          isWarning ? "text-swarm-budget-warning font-medium" : "text-muted-foreground",
        )}>
          {hasBreakdown ? (
            <span className="inline-flex items-center gap-1">
              <span>↑{formatTokenCount(inputTokens)}</span>
              <span>↓{formatTokenCount(outputTokens)}</span>
            </span>
          ) : (
            <span>{formatTokenCount(consumed)}{max ? `/${formatTokenCount(max)}` : ""}</span>
          )}
        </span>
      )}
    </div>
  )
}
