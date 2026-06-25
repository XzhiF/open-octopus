"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { MetricCard } from "../atoms/metric-card"
import { SwarmBadge } from "../atoms/swarm-badge"
import { Users, Repeat2, Gauge, Coins, X } from "lucide-react"
import type { SwarmMode, SwarmStatus } from "@/lib/swarm-types"
import { DialogClose } from "@/components/ui/dialog"

export interface SwarmHeaderBarProps {
  nodeName: string
  mode: SwarmMode | null
  status: SwarmStatus
  expertCount: number
  currentRound: number
  consensusScore: number | null
  budgetPercentage?: number
  isReplay?: boolean
}

export function SwarmHeaderBar({
  nodeName,
  mode,
  status,
  expertCount,
  currentRound,
  consensusScore,
  budgetPercentage,
  isReplay = false,
}: SwarmHeaderBarProps) {
  const isRunning = status === "running" || status === "initializing"
  const isBudgetWarning = budgetPercentage != null && budgetPercentage >= 90

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold truncate flex-1">{nodeName}</h2>
        {mode && <SwarmBadge mode={mode} />}
        {isReplay && (
          <Badge variant="outline" className="text-xs text-muted-foreground" data-testid="replay-badge">
            回放模式
          </Badge>
        )}
        {isRunning && (
          <div className="h-2 w-2 rounded-full bg-swarm-expert-running animate-swarm-pulse" />
        )}
        <DialogClose className="shrink-0 rounded-sm opacity-70 hover:opacity-100 transition-opacity">
          <X className="h-4 w-4" />
          <span className="sr-only">关闭</span>
        </DialogClose>
      </div>

      <div className={cn(
        "grid gap-2",
        "grid-cols-2 sm:grid-cols-4",
      )}>
        <MetricCard
          label="专家"
          value={expertCount}
          icon={Users}
        />
        <MetricCard
          label="轮次"
          value={currentRound}
          icon={Repeat2}
        />
        <MetricCard
          label="预算"
          value={budgetPercentage != null ? `${budgetPercentage.toFixed(0)}%` : "-"}
          icon={Coins}
          warning={isBudgetWarning}
          maxValue={100}
        />
        <MetricCard
          label="共识"
          value={consensusScore != null ? consensusScore.toFixed(2) : "-"}
          icon={Gauge}
        />
      </div>
    </div>
  )
}
