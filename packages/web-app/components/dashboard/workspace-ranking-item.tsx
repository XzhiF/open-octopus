"use client"

import { useState } from "react"
import { formatTokenCount } from "@/lib/format"
import { LEADERBOARD_MAX_VISIBLE_MODELS } from "@/lib/constants"
import type { WorkspaceRanking } from "@/lib/types"
import { ModelUsageRow } from "./model-usage-row"

interface WorkspaceRankingItemProps {
  rank: number
  item: WorkspaceRanking
}

export function WorkspaceRankingItem({ rank, item }: WorkspaceRankingItemProps) {
  const [expanded, setExpanded] = useState(false)

  const visibleModels = expanded
    ? item.models
    : item.models.slice(0, LEADERBOARD_MAX_VISIBLE_MODELS)
  const hasMore = item.models.length > LEADERBOARD_MAX_VISIBLE_MODELS

  const formatCost = (cost: number | null, complete: boolean) => {
    if (cost === null) return "-"
    return complete ? `$${cost.toFixed(4)}` : `≈$${cost.toFixed(4)}`
  }

  return (
    <div
      className="border-b border-border/50 py-3 last:border-0"
      role="listitem"
      tabIndex={0}
      aria-label={`第${rank}名：${item.workspaceName}，总计 ${formatTokenCount(item.totalTokens)} tokens`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-semibold text-muted-foreground">#{rank}</span>
          <span className="font-medium truncate" title={item.workspaceName}>
            {item.workspaceName}
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm shrink-0">
          <span className="font-semibold tabular-nums">
            {formatTokenCount(item.totalTokens)}
          </span>
          <span className="text-muted-foreground tabular-nums text-xs">
            {formatCost(item.totalCostUsd, item.costComplete)}
          </span>
        </div>
      </div>
      <div className="space-y-1 ml-6" id={`models-${item.workspaceId}`}>
        {visibleModels.map((usage, i) => (
          <ModelUsageRow key={`${usage.model}-${i}`} usage={usage} />
        ))}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls={`models-${item.workspaceId}`}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? '收起' : `…+${item.models.length - LEADERBOARD_MAX_VISIBLE_MODELS} 模型`}
          </button>
        )}
      </div>
    </div>
  )
}
