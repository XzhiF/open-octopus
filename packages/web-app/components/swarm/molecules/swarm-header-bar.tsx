"use client"

import { cn } from "@/lib/utils"
import { formatPercent } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { MetricCard } from "../atoms/metric-card"
import { SwarmBadge } from "../atoms/swarm-badge"
import { Users, Repeat2, Gauge, Coins } from "lucide-react"
import type { SwarmMode, SwarmStatus } from "@/lib/swarm-types"
import { DialogClose } from "@/components/ui/dialog"
import { CloseLightGlyph, closeLightButtonBase } from "@/components/ui/close-light"

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
        <DialogClose aria-label="关闭" className={cn(closeLightButtonBase, 'shrink-0')}>
          <CloseLightGlyph />
        </DialogClose>
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
          value={formatPercent(budgetPercentage != null ? budgetPercentage / 100 : null)}
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
