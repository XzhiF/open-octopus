"use client"

import { Workflow } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { WorkflowStat } from "@octopus/shared"

interface WorkflowRankingCardsProps {
  workflows: WorkflowStat[]
  loading?: boolean
}

function WorkflowCard({ workflow, rank }: { workflow: WorkflowStat; rank: number }) {
  const successPct = (workflow.success_rate * 100).toFixed(1)

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-border/50 py-3 last:border-0",
      )}
      role="listitem"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
        {rank}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium" title={workflow.workflow_name}>
          {workflow.workflow_name}
        </p>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">{workflow.runs} runs</span>
          <span className="tabular-nums">{successPct}%</span>
          <span className="tabular-nums">${workflow.total_cost_usd.toFixed(4)}</span>
        </div>
      </div>
    </div>
  )
}

export function WorkflowRankingCards({ workflows, loading }: WorkflowRankingCardsProps) {
  if (loading) {
    return (
      <Card className="py-3 gap-2" role="region" aria-label="工作流排名">
        <CardHeader className="pb-1 pt-1 px-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="h-4 w-4" />
            工作流排名
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pt-0 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  const sorted = [...workflows].sort((a, b) => b.runs - a.runs)

  return (
    <Card className="py-3 gap-2" role="region" aria-label="工作流排名">
      <CardHeader className="pb-1 pt-1 px-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Workflow className="h-4 w-4" />
          工作流排名
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pt-0 overflow-y-auto max-h-[400px]" role="list" aria-label="工作流排名列表">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
            <p className="text-sm">暂无工作流数据</p>
          </div>
        ) : (
          sorted.map((wf, i) => (
            <WorkflowCard key={wf.workflow_ref} workflow={wf} rank={i + 1} />
          ))
        )}
      </CardContent>
    </Card>
  )
}
