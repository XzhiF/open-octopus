"use client"

import { useMemo } from "react"
import { Loader2 } from "lucide-react"
import { ExpertRow } from "../molecules/expert-row"
import { RouterDecisionCard } from "../molecules/router-decision-card"
import type { ExpertInfo, RouterDecision } from "@/lib/swarm-types"

export interface ExpertListTabProps {
  experts: ExpertInfo[]
  routerDecision: RouterDecision | null
  highlightedRole?: string | null
  onHighlightClear?: () => void
}

const statusOrder: Record<string, number> = {
  running: 0,
  pending: 1,
  completed: 2,
  failed: 3,
  budget_exceeded: 4,
  skipped: 5,
}

export function ExpertListTab({ experts, routerDecision, highlightedRole }: ExpertListTabProps) {
  const sorted = useMemo(() => {
    return [...experts].sort((a, b) => {
      const orderA = statusOrder[a.status] ?? 99
      const orderB = statusOrder[b.status] ?? 99
      return orderA - orderB
    })
  }, [experts])

  const hasRunning = experts.some(e => e.status === "running")
  const isEmpty = experts.length === 0

  return (
    <div className="space-y-3">
      {routerDecision && (
        <RouterDecisionCard decision={routerDecision} />
      )}

      {isEmpty && hasRunning && (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在初始化专家...</span>
        </div>
      )}

      {isEmpty && !hasRunning && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          暂无专家信息
        </div>
      )}

      {/* Loading skeletons */}
      {isEmpty && hasRunning && (
        <div className="space-y-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 animate-pulse">
              <div className="h-8 w-8 rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-24 rounded bg-muted" />
                <div className="h-2 w-full rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {sorted.map(expert => (
          <ExpertRow
            key={expert.role}
            expert={expert}
            highlighted={highlightedRole === expert.role}
          />
        ))}
      </div>
    </div>
  )
}
