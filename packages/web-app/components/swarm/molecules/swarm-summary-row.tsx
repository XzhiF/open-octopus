"use client"

import { cn } from "@/lib/utils"
import { SwarmBadge } from "../atoms/swarm-badge"
import { StatusDot } from "../atoms/status-dot"
import type { SwarmMode, ExpertStatus } from "@/lib/swarm-types"

export interface SwarmSummaryRowProps {
  mode: SwarmMode
  status: ExpertStatus
  expertCount: number
  rounds: number
  consensusScore: number | null
  onClick?: () => void
}

export function SwarmSummaryRow({
  mode,
  status,
  expertCount,
  rounds,
  consensusScore,
  onClick,
}: SwarmSummaryRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 w-full px-3 py-2 rounded-md",
        "hover:bg-accent/50 transition-colors text-left",
        "border border-transparent hover:border-border",
      )}
    >
      <SwarmBadge mode={mode} size="sm" />
      <StatusDot status={status} pulse={status === "running"} size="sm" />

      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-1 min-w-0">
        <span className="shrink-0">{expertCount} 专家</span>
        <span className="shrink-0">{rounds} 轮</span>
        {consensusScore != null && (
          <span className="shrink-0 tabular-nums">
            共识: {consensusScore.toFixed(2)}
          </span>
        )}
      </div>
    </button>
  )
}
