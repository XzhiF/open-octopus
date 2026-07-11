"use client"

import { memo } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import type { IterationNodeResult } from "@/lib/types"

interface IterationTimelineProps {
  nodes: IterationNodeResult[]
}

const statusConfig: Record<IterationNodeResult["status"], { label: string; className: string }> = {
  completed: { label: "✅", className: "text-emerald-500" },
  failed: { label: "❌", className: "text-red-400" },
  running: { label: "🔄", className: "text-amber-400" },
  pending: { label: "⏳", className: "text-muted-foreground" },
  skipped: { label: "⏭", className: "text-muted-foreground" },
}

export const IterationTimeline = memo(function IterationTimeline({ nodes }: IterationTimelineProps) {
  if (nodes.length === 0) {
    return <div className="text-xs text-muted-foreground py-1">无子节点数据</div>
  }

  return (
    <div className="space-y-0.5 py-1">
      {nodes.map((node) => {
        const cfg = statusConfig[node.status]
        return (
          <div
            key={node.nodeId}
            className="flex items-center gap-2 text-xs px-2 py-0.5 rounded hover:bg-muted/30"
          >
            <span className="truncate font-mono text-muted-foreground flex-1 min-w-0">
              {node.nodeId}
            </span>
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1 shrink-0", cfg.className)}
            >
              {cfg.label} {node.status}
            </Badge>
            {node.durationMs != null && (
              <span className="text-muted-foreground/60 tabular-nums text-[10px] shrink-0">
                {formatDuration(node.durationMs / 1000)}
              </span>
            )}
            {node.error && (
              <span className="text-red-400 text-[10px] truncate max-w-[120px] shrink-0" title={node.error}>
                {node.error}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
})
