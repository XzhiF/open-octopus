"use client"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Progress } from "@/components/ui/progress"
import { formatCostUSD } from "@/lib/cost-format"
import { useRouter } from "next/navigation"
import type { LeaderboardEntry } from "@/lib/archive-api"
import { cn } from "@/lib/utils"

interface WorkflowRankingProps {
  entries: LeaderboardEntry[]
  loading: boolean
  sortBy: "count" | "success_rate" | "cost"
  onSortChange: (by: "count" | "success_rate" | "cost") => void
}

const rankColors: Record<number, string> = {
  1: "text-memory-rank-1",
  2: "text-memory-rank-2",
  3: "text-memory-rank-3",
}

export function WorkflowRanking({ entries, loading, sortBy, onSortChange }: WorkflowRankingProps) {
  const router = useRouter()

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">工作流排行</h3>
        <ToggleGroup
          type="single"
          value={sortBy}
          onValueChange={v => { if (v) onSortChange(v as typeof sortBy) }}
          size="sm"
        >
          <ToggleGroupItem value="count">次数</ToggleGroupItem>
          <ToggleGroupItem value="success_rate">成功率</ToggleGroupItem>
          <ToggleGroupItem value="cost">成本</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-12 rounded bg-muted animate-pulse" />)}
        </div>
      )}

      {!loading && entries.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">暂无排行数据</p>
      )}

      {!loading && entries.length > 0 && (
        <div className="space-y-2">
          {entries.slice(0, 10).map((entry) => (
            <button
              key={entry.workflow_ref}
              className={cn(
                "w-full text-left rounded-md border p-3 hover:bg-accent/50 transition-colors",
                "flex items-center gap-3"
              )}
              onClick={() => router.push(`/archive/executions?workflow=${encodeURIComponent(entry.workflow_ref)}`)}
            >
              <span className={cn("text-lg font-bold w-6 text-center", rankColors[entry.rank] ?? "text-muted-foreground")}>
                {entry.rank}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium truncate">{entry.workflow_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {sortBy === "cost" ? formatCostUSD(entry.total_cost_usd) :
                     sortBy === "success_rate" ? `${Math.round(entry.success_rate * 100)}%` :
                     `${entry.execution_count} 次`}
                  </span>
                </div>
                {sortBy === "success_rate" && (
                  <Progress value={entry.success_rate * 100} className="mt-1 h-1.5" />
                )}
                {sortBy !== "success_rate" && (
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{entry.execution_count} 次</span>
                    <span>{Math.round(entry.success_rate * 100)}% 成功</span>
                    <span>{formatCostUSD(entry.total_cost_usd)}</span>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
