"use client"

import { formatTokenCount } from "@/lib/format"
import type { ModelRanking } from "@/lib/types"

interface ModelRankingItemProps {
  rank: number
  item: ModelRanking
}

export function ModelRankingItem({ rank, item }: ModelRankingItemProps) {
  const formatCost = (cost: number | null, complete: boolean) => {
    if (cost === null) return "-"
    return complete ? `$${cost.toFixed(4)}` : `≈$${cost.toFixed(4)}`
  }

  // 计算输入总计、输出总计
  const totalInput = item.inputTokens + item.cacheReadTokens
  const totalOutput = item.outputTokens + item.cacheCreationTokens

  return (
    <div
      className="border-b border-border/50 py-3 last:border-0"
      role="listitem"
      tabIndex={0}
      aria-label={`第${rank}名：${item.model}，总计 ${formatTokenCount(item.totalTokens)} tokens`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-semibold text-muted-foreground">#{rank}</span>
          <span className="font-medium" title={item.model}>
            {item.model}
          </span>
        </div>
        <span className="font-bold tabular-nums text-sm text-foreground pr-8">
          {formatCost(item.costUsd, item.costComplete)}
        </span>
      </div>
      <div className="ml-6 grid grid-cols-3 gap-3 text-xs tabular-nums mb-2">
        <div className="text-center">
          <div className="text-muted-foreground">输入总计</div>
          <div className="font-semibold">↑{formatTokenCount(totalInput)}</div>
          <div className="text-[10px] text-muted-foreground/70 mt-0.5">
            输入 {formatTokenCount(item.inputTokens)} + 缓存 {formatTokenCount(item.cacheReadTokens)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">输出总计</div>
          <div className="font-semibold">↓{formatTokenCount(totalOutput)}</div>
          <div className="text-[10px] text-muted-foreground/70 mt-0.5">
            输出 {formatTokenCount(item.outputTokens)} + 缓存 {formatTokenCount(item.cacheCreationTokens)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">总计</div>
          <div className="font-semibold">{formatTokenCount(item.totalTokens)}</div>
          <div className="text-[10px] text-muted-foreground/70 mt-0.5">
            输入+输出
          </div>
        </div>
      </div>
    </div>
  )
}
