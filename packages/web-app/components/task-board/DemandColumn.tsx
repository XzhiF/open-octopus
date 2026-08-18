"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { DemandCard } from "./DemandCard"
import type { Demand, DemandStatus } from "@octopus/shared"

interface DemandColumnProps {
  status: DemandStatus
  demands: Demand[]
  count: number
  onSelect: (demand: Demand) => void
}

const STATUS_LABELS: Record<DemandStatus, string> = {
  draft: "Draft",
  discussing: "Discussing",
  incubated: "Incubated",
  ready: "Ready",
  dispatched: "Dispatched",
  executing: "Executing",
  done: "Done",
  failed: "Failed",
}

const STATUS_COLORS: Record<DemandStatus, string> = {
  draft: "bg-gray-400/15 text-gray-600 dark:bg-gray-400/20 dark:text-gray-400",
  discussing: "bg-blue-400/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400",
  incubated: "bg-purple-400/15 text-purple-600 dark:bg-purple-400/20 dark:text-purple-400",
  ready: "bg-green-400/15 text-green-600 dark:bg-green-400/20 dark:text-green-400",
  dispatched: "bg-cyan-400/15 text-cyan-600 dark:bg-cyan-400/20 dark:text-cyan-400",
  executing: "bg-amber-400/15 text-amber-600 dark:bg-amber-400/20 dark:text-amber-400",
  done: "bg-emerald-400/15 text-emerald-600 dark:bg-emerald-400/20 dark:text-emerald-400",
  failed: "bg-red-400/15 text-red-600 dark:bg-red-400/20 dark:text-red-400",
}

export function DemandColumn({ status, demands, count, onSelect }: DemandColumnProps) {
  return (
    <div
      data-slot="demand-column"
      className="flex min-w-[240px] max-w-[300px] flex-1 flex-col rounded-lg border bg-muted/30"
    >
      {/* Header */}
      <div
        data-slot="demand-column-header"
        className={cn(
          "flex items-center justify-between rounded-t-lg px-3 py-2",
          STATUS_COLORS[status]
        )}
      >
        <span className="text-sm font-medium">
          {STATUS_LABELS[status]}
        </span>
        <Badge variant="secondary" className="text-[10px] h-5 min-w-5 px-1.5">
          {count}
        </Badge>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 overflow-y-auto p-2" style={{ maxHeight: "calc(100vh - 280px)" }}>
        {demands.map((demand) => (
          <DemandCard key={demand.id} demand={demand} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}
