"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Workflow } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia, EmptyContent } from "@/components/ui/empty"
import { fetchWorkflowStats, type WorkflowStat } from "@/lib/archive-api"

type SortKey = "execution_count" | "success_rate" | "total_cost_usd"

const sortLabels: Record<SortKey, string> = {
  execution_count: "次数",
  success_rate: "成功率",
  total_cost_usd: "成本",
}

const rankColors = [
  "text-amber-500",   // 1st
  "text-zinc-400",    // 2nd
  "text-orange-600",  // 3rd
  "text-muted-foreground", // 4th
  "text-muted-foreground", // 5th
]

export function WorkflowRanking() {
  const [items, setItems] = useState<WorkflowStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>("execution_count")

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchWorkflowStats({ sort: sortBy, order: "desc", limit: 10 })
        if (!cancelled) {
          setItems(result.items)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "获取工作流排行失败")
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [sortBy])

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-8 w-36" />
          </div>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-5 w-5" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            className="text-sm text-primary underline"
            onClick={() => { setLoading(true); setError(null) }}
          >
            重试
          </button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">工作流排行</h3>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={sortBy}
            onValueChange={(v) => { if (v) setSortBy(v as SortKey) }}
          >
            {(Object.keys(sortLabels) as SortKey[]).map((key) => (
              <ToggleGroupItem key={key} value={key} aria-label={sortLabels[key]}>
                {sortLabels[key]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {items.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Workflow className="h-5 w-5" />
              </EmptyMedia>
              <EmptyTitle>暂无工作流执行数据</EmptyTitle>
              <EmptyDescription>
                运行工作流后将在此显示排行
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-3">
            {items.map((item, i) => (
              <div key={item.workflow_ref} className="group">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center text-xs font-bold tabular-nums",
                      i < 5 ? rankColors[i] : "text-muted-foreground"
                    )}
                  >
                    {i + 1}
                  </span>
                  <Link
                    href={`/archive/executions?workflow=${encodeURIComponent(item.workflow_ref)}`}
                    className="flex-1 truncate text-sm font-medium hover:text-primary hover:underline transition-colors"
                  >
                    {item.workflow_name || item.workflow_ref}
                  </Link>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="secondary" className="text-[10px] px-1.5 tabular-nums">
                      {item.execution_count} 次
                    </Badge>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-3 pl-8">
                  <div className="flex-1">
                    <Progress
                      value={item.success_rate * 100}
                      className="h-1.5"
                    />
                  </div>
                  <span className="text-[11px] tabular-nums text-muted-foreground w-10 text-right">
                    {Math.round(item.success_rate * 100)}%
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground w-14 text-right">
                    ${item.total_cost_usd.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
