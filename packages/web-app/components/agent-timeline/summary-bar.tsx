"use client"

import { cn } from "@/lib/utils"
import type { LLMCallAggregates } from "@/lib/types"
import { ArrowUp, ArrowDown, Coins, Zap } from "lucide-react"

interface SummaryBarProps {
  turnCount: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  turnDurations?: { turnIndex: number; durationMs: number }[]
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function SummaryBar({ turnCount, totalDurationMs, totalInputTokens, totalOutputTokens, totalCostUsd, turnDurations }: SummaryBarProps) {
  const maxDuration = turnDurations ? Math.max(...turnDurations.map(t => t.durationMs), 1) : 1

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">{turnCount} turns</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{formatDuration(totalDurationMs)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="flex items-center gap-1 tabular-nums">
          <ArrowUp className="h-3 w-3 text-violet-500" />{formatTokens(totalInputTokens)}
        </span>
        <span className="flex items-center gap-1 tabular-nums">
          <ArrowDown className="h-3 w-3 text-blue-500" />{formatTokens(totalOutputTokens)}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="flex items-center gap-1 tabular-nums font-medium">
          <Coins className="h-3 w-3 text-amber-500" />${totalCostUsd.toFixed(2)}
        </span>
      </div>

      {turnDurations && turnDurations.length > 0 && (
        <div className="mt-2 flex items-end gap-0.5 h-4">
          {turnDurations.map((t, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-violet-500/40 transition-all"
              style={{ height: `${Math.max((t.durationMs / maxDuration) * 100, 10)}%` }}
              title={`T${t.turnIndex}: ${formatDuration(t.durationMs)}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
