"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import type { Demand, DemandPriority } from "@octopus/shared"

interface DemandCardProps {
  demand: Demand
  onSelect: (demand: Demand) => void
}

const PRIORITY_COLORS: Record<DemandPriority, string> = {
  critical: "bg-red-500/15 text-red-600 border-red-200 dark:bg-red-500/20 dark:text-red-400 dark:border-red-800",
  high: "bg-orange-500/15 text-orange-600 border-orange-200 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-800",
  normal: "bg-blue-500/15 text-blue-600 border-blue-200 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-800",
  low: "bg-gray-400/15 text-gray-600 border-gray-200 dark:bg-gray-400/20 dark:text-gray-400 dark:border-gray-700",
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(dateStr).toLocaleDateString()
}

export function DemandCard({ demand, onSelect }: DemandCardProps) {
  return (
    <div
      data-slot="demand-card"
      className="cursor-pointer rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-accent/50"
      onClick={() => onSelect(demand)}
    >
      <div className="flex flex-col gap-2">
        {/* Title */}
        <div
          data-slot="demand-card-title"
          className="truncate text-sm font-medium text-card-foreground"
          title={demand.title}
        >
          {demand.title}
        </div>

        {/* Priority badge + project tag */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge
            variant="outline"
            className={cn("text-[10px] px-1.5", PRIORITY_COLORS[demand.priority])}
          >
            {demand.priority}
          </Badge>
          {demand.project_ids[0] && (
            <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
              {demand.project_ids[0]}
            </span>
          )}
        </div>

        {/* Created at */}
        <div className="text-[10px] text-muted-foreground">
          {formatRelativeTime(demand.created_at)}
        </div>
      </div>
    </div>
  )
}
