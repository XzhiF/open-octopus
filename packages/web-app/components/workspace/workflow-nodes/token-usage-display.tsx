"use client"

import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"
import type { TokenUsage } from "@/lib/types"
import { TokenDetailPopover } from "./token-detail-popover"

interface TokenUsageDisplayProps {
  usages: TokenUsage[]
  isRunning: boolean
  maxVisible?: number
}

const DEFAULT_MAX_VISIBLE = 3

export function TokenUsageDisplay({ usages, isRunning, maxVisible = DEFAULT_MAX_VISIBLE }: TokenUsageDisplayProps) {
  const filtered = usages.filter(u => u.inputTokens > 0 || u.outputTokens > 0)

  if (filtered.length === 0) return null

  const visible = filtered.slice(0, maxVisible)
  const overflow = filtered.length - maxVisible
  const hasOverflow = overflow > 0

  const rowColor = isRunning ? "text-amber-600 font-medium" : "text-muted-foreground"

  return (
    <div className="space-y-0.5 mt-1">
      {visible.map((u, i) => {
        // C3: 折叠口径废除 —— 纯值。缓存两路(⚡读/🗡写)单独一行弱化展示：
        // 与监控面板 totalTokens 同口径可互相印证(↑in+↓out+⚡cacheRead+🗡️cacheWrite == 总)，
        // 且 4 项塞进 280px 节点框会溢出，故折两行——主行模型+净吞吐，次行缓存明细。
        const cacheRead = u.cacheReadTokens ?? 0
        const cacheWrite = u.cacheCreationTokens ?? 0
        const hasCache = cacheRead > 0 || cacheWrite > 0
        return (
          <div key={`${u.model}-${i}`} className="leading-tight">
            <div className={cn("text-xs tabular-nums flex items-center gap-1", rowColor)}>
              <span className="font-medium truncate max-w-[160px]">{u.model}</span>
              <span>↑{formatTokenCount(u.inputTokens)}</span>
              <span>↓{formatTokenCount(u.outputTokens)}</span>
            </div>
            {hasCache && (
              <div className="text-[10px] tabular-nums text-muted-foreground flex items-center gap-2">
                {cacheRead > 0 && <span title="缓存读取">⚡{formatTokenCount(cacheRead)}</span>}
                {cacheWrite > 0 && <span title="缓存创建">🗡️{formatTokenCount(cacheWrite)}</span>}
              </div>
            )}
          </div>
        )
      })}
      {hasOverflow && (
        <TokenDetailPopover usages={filtered} isRunning={isRunning}>
          <span className={cn("text-xs cursor-pointer hover:underline", rowColor)}>
            …+{overflow} 模型
          </span>
        </TokenDetailPopover>
      )}
    </div>
  )
}
