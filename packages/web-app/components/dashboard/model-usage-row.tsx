"use client"

import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"
import type { ModelUsageGroup } from "@/lib/types"

interface ModelUsageRowProps {
  usage: ModelUsageGroup
  className?: string
}

export function ModelUsageRow({ usage, className }: ModelUsageRowProps) {
  const formatCost = (cost: number | null) => {
    if (cost === null) return "-"
    return `$${cost.toFixed(4)}`
  }

  // 计算总数：输入总数 = input + cache_read，输出总数 = output + cache_creation
  const totalInput = usage.inputTokens + usage.cacheReadTokens
  const totalOutput = usage.outputTokens + usage.cacheCreationTokens

  const tooltip = `总输入: ${formatTokenCount(totalInput)}\n  - 输入: ${formatTokenCount(usage.inputTokens)}\n  - 缓存读: ${formatTokenCount(usage.cacheReadTokens)}\n总输出: ${formatTokenCount(totalOutput)}\n  - 输出: ${formatTokenCount(usage.outputTokens)}\n  - 缓存写: ${formatTokenCount(usage.cacheCreationTokens)}`

  return (
    <div className={cn("text-xs tabular-nums flex items-center gap-2 flex-wrap", className)} title={tooltip}>
      <span className="font-medium shrink-0" title={usage.model}>
        {usage.model}
      </span>
      <span className="text-muted-foreground flex items-center gap-2">
        <span>↑{formatTokenCount(totalInput)}</span>
        <span>↓{formatTokenCount(totalOutput)}</span>
      </span>
      <span className="text-muted-foreground ml-auto">
        {formatCost(usage.costUsd)}
      </span>
    </div>
  )
}
