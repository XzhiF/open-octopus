"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"
import type { TokenUsage } from "@/lib/types"

interface TokenUsageLineProps {
  usage?: TokenUsage
  isRunning: boolean
}

function useTokenBump(isRunning: boolean, inputTokens: number, outputTokens: number): string {
  const [bumpKey, setBumpKey] = useState(0)
  const prevTotalRef = useRef(0)
  const total = inputTokens + outputTokens
  useEffect(() => {
    if (isRunning && total !== prevTotalRef.current && prevTotalRef.current > 0) {
      setBumpKey(k => k + 1)
    }
    prevTotalRef.current = total
  }, [isRunning, total])
  return isRunning && bumpKey > 0 ? "animate-token-bump" : ""
}

export function TokenUsageLine({ usage, isRunning }: TokenUsageLineProps) {
  const bumpClass = useTokenBump(isRunning, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0)

  if (!usage) return null
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return null

  const color = isRunning ? "text-amber-600 font-medium" : "text-muted-foreground"

  return (
    <div className={cn("text-xs tabular-nums flex items-center gap-1 px-3 pb-1", color)}>
      <span className="font-medium truncate max-w-[120px]">{usage.model}</span>
      <span className={bumpClass}>↑{formatTokenCount(usage.inputTokens)}</span>
      <span className={bumpClass}>↓{formatTokenCount(usage.outputTokens)}</span>
      {isRunning && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
      )}
    </div>
  )
}