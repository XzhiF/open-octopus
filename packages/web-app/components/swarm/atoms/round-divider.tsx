"use client"

import { cn } from "@/lib/utils"

export interface RoundDividerProps {
  round: number
  timestamp?: string
  expertCount?: number
}

export function RoundDivider({ round, timestamp, expertCount }: RoundDividerProps) {
  return (
    <div className="flex items-center gap-3 py-2 select-none" role="separator">
      <div className="flex-1 border-t border-dashed border-border" />
      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
        Round {round}
      </span>
      <div className="flex-1 border-t border-dashed border-border" />
      {(timestamp || expertCount != null) && (
        <span className={cn("text-[10px] text-muted-foreground/70 whitespace-nowrap")}>
          {expertCount != null && `${expertCount} experts`}
          {expertCount != null && timestamp && " · "}
          {timestamp}
        </span>
      )}
    </div>
  )
}
