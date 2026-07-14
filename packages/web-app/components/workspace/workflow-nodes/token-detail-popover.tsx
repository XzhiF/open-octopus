"use client"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"
import type { TokenUsage } from "@/lib/types"

interface TokenDetailPopoverProps {
  usages: TokenUsage[]
  isRunning: boolean
  children: React.ReactNode
}

export function TokenDetailPopover({ usages, isRunning, children }: TokenDetailPopoverProps) {
  const totalInput = usages.reduce((sum, u) => sum + u.inputTokens + (u.cacheReadTokens ?? 0), 0)
  const totalOutput = usages.reduce((sum, u) => sum + u.outputTokens + (u.cacheCreationTokens ?? 0), 0)

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-3" side="right" align="start">
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Token 使用详情
          </h4>
          {usages.map((u, i) => {
            const hasCache = (u.cacheReadTokens ?? 0) > 0 || (u.cacheCreationTokens ?? 0) > 0
            return (
            <div key={`${u.model}-${i}`} className="space-y-1">
              <div className="text-xs font-medium border-b border-dashed border-border/50 pb-0.5">
                {u.model}
                {isRunning && (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse ml-1" />
                )}
              </div>
              <div className={cn("text-xs tabular-nums pl-1", isRunning ? "text-amber-600" : "text-muted-foreground")}>
                Input: {formatTokenCount(u.inputTokens + (u.cacheReadTokens ?? 0))}
                {(u.cacheReadTokens ?? 0) > 0 && (
                  <span className="text-muted-foreground/60 ml-1">(cache {formatTokenCount(u.cacheReadTokens)})</span>
                )}
              </div>
              <div className={cn("text-xs tabular-nums pl-1", isRunning ? "text-amber-600" : "text-muted-foreground")}>
                Output: {formatTokenCount(u.outputTokens + (u.cacheCreationTokens ?? 0))}
                {(u.cacheCreationTokens ?? 0) > 0 && (
                  <span className="text-muted-foreground/60 ml-1">(cache {formatTokenCount(u.cacheCreationTokens)})</span>
                )}
              </div>
            </div>
            )
          })}
          <div className="border-t pt-1 space-y-0.5">
            <div className={cn("text-xs tabular-nums font-medium", isRunning ? "text-amber-600" : "text-muted-foreground")}>
              合计 ↑{formatTokenCount(totalInput)} ↓{formatTokenCount(totalOutput)}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}