"use client"

import { useState } from "react"
import Link from "next/link"
import { formatTokenCount } from "@/lib/format"
import { LEADERBOARD_MAX_VISIBLE_MODELS } from "@/lib/constants"
import type { ExecutionRanking } from "@/lib/types"
import { ModelUsageRow } from "./model-usage-row"

interface WorkflowRankingItemProps {
  rank: number
  item: ExecutionRanking
}

export function WorkflowRankingItem({ rank, item }: WorkflowRankingItemProps) {
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
      aria-label={`第${rank}名：${item.workflowName}（${item.workspaceName}），总计 ${formatTokenCount(item.totalTokens)} tokens`}
    >
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-semibold text-muted-foreground">#{rank}</span>
          <Link
            href={`/workspaces/${item.workspaceId}?tab=detail&execId=${item.executionId}`}
            className="text-xs bg-muted px-1.5 py-0.5 rounded truncate text-primary hover:underline"
            title={item.workflowRef}
          >
            {item.workflowRef}
          </Link>
        </div>
      </div>
      <div className="ml-6 mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate"><span aria-hidden="true">📁</span> {item.workspaceName}</span>
        <span className="truncate text-[10px] font-mono" title={item.executionId}>
          exec:{item.executionId.slice(0, 8)}
        </span>
        <span className="ml-auto font-semibold tabular-nums shrink-0">
          {formatTokenCount(item.totalTokens)}
        </span>
        <span className="tabular-nums shrink-0">
          {formatCost(item.totalCostUsd, item.costComplete)}
        </span>
      </div>
      <div className="space-y-1 ml-6" id={`models-wf-${item.executionId}-${rank}`}>
        {visibleModels.map((usage, i) => (
          <ModelUsageRow key={`${usage.model}-${i}`} usage={usage} />
        ))}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls={`models-wf-${item.executionId}-${rank}`}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? '收起' : `…+${item.models.length - LEADERBOARD_MAX_VISIBLE_MODELS} 模型`}
          </button>
        )}
      </div>
    </div>
  )
}
