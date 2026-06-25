"use client"

import { cn } from "@/lib/utils"
import { Coins, Repeat, Wrench, Clock } from "lucide-react"

interface CostLineProps {
  costUsd: number
  turns?: number
  tools?: number
  durationMs?: number
}

export function CostLine({ costUsd, turns, tools, durationMs }: CostLineProps) {
  const parts: React.ReactNode[] = []

  parts.push(
    <span key="cost" className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
      <Coins className="h-3 w-3" />${costUsd.toFixed(2)}
    </span>
  )

  if (turns) {
    parts.push(
      <span key="turns" className="flex items-center gap-1">
        <Repeat className="h-3 w-3" />{turns} turns
      </span>
    )
  }

  if (tools) {
    parts.push(
      <span key="tools" className="flex items-center gap-1">
        <Wrench className="h-3 w-3" />{tools} tools
      </span>
    )
  }

  if (durationMs != null && durationMs > 0) {
    const seconds = durationMs / 1000
    parts.push(
      <span key="duration" className="flex items-center gap-1">
        <Clock className="h-3 w-3" />{seconds < 60 ? `${seconds.toFixed(0)}s` : `${(seconds / 60).toFixed(1)}m`}
      </span>
    )
  }

  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground tabular-nums mt-2 pt-2 border-t")}>
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          {part}
        </span>
      ))}
    </div>
  )
}
