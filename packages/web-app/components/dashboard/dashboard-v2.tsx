"use client"

import { useState } from "react"
import Link from "next/link"
import { HeroMetrics } from "./hero-metrics"
import { WorkflowHealthCard } from "./workflow-health-card"
import { CostTrendChart } from "./cost-trend-chart"
import { QueuePanel } from "./queue-panel"
import { RecentExecutions } from "./recent-executions"
import { useWorkspaceAnalytics } from "@/hooks/use-workflow-analytics"
import { Button } from "@/components/ui/button"
import { PlusCircle } from "lucide-react"
import type { DashboardStats, Execution } from "@/lib/types"

interface DashboardV2Props {
  workspaceId?: string
  dashboardStats?: DashboardStats
}

export function DashboardV2({ workspaceId, dashboardStats }: DashboardV2Props) {
  const hasWorkspace = !!workspaceId
  const { data, loading } = useWorkspaceAnalytics(workspaceId ?? '', '30d')
  const [runningExecutions] = useState<Execution[]>([])

  // When no workspaceId, skip loading state and render with zeros
  if (loading && hasWorkspace) {
    return <div className="space-y-6"><div className="text-muted-foreground">加载中...</div></div>
  }

  const analytics = data?.data
  const workflows = data?.workflows ?? []
  const costDaily = data?.dailyTrend ?? []

  // Use observability data if available, otherwise fall back to dashboard stats
  const totalExecutions = analytics?.totalExecutions ?? dashboardStats?.completedToday ?? 0
  const successRate = analytics?.successRate ?? (
    dashboardStats && (dashboardStats.completedToday + dashboardStats.failedToday) > 0
      ? dashboardStats.completedToday / (dashboardStats.completedToday + dashboardStats.failedToday)
      : 0
  )
  const totalCost = analytics?.totalCost ?? 0
  const avgDurationMs = analytics?.avgDurationMs ?? 0

  return (
    <div className="space-y-6">
      <HeroMetrics
        totalExecutions={totalExecutions}
        successRate={successRate}
        totalCost={totalCost}
        avgDurationMs={avgDurationMs}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-4">
          <QueuePanel runningExecutions={runningExecutions} pendingExecutions={[]} />
        </div>
        <div className="lg:col-span-2 space-y-4">
          <h3 className="text-sm font-medium">Workflow 健康度</h3>
          {workflows.length === 0 ? (
            <div className="rounded-lg border bg-card p-12 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <PlusCircle className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-sm font-medium">还没有工作流</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                创建你的第一个工作流以查看健康度分析
              </p>
              <Button className="mt-4" size="sm" asChild>
                <Link href="/workspaces">
                  <PlusCircle className="mr-2 h-4 w-4" />
                  创建工作流
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {workflows.slice(0, 5).map((w) => {
                const workflow = w as { workflow_ref: string; success_rate: number | null; avg_duration_ms: number | null }
                return (
                <WorkflowHealthCard
                  key={workflow.workflow_ref}
                  workflowRef={workflow.workflow_ref}
                  healthScore={workflow.success_rate ? Math.round(workflow.success_rate * 100) : 0}
                  grade={workflow.success_rate && workflow.success_rate > 0.9 ? 'A' : workflow.success_rate && workflow.success_rate > 0.75 ? 'B' : workflow.success_rate && workflow.success_rate > 0.6 ? 'C' : workflow.success_rate && workflow.success_rate > 0.4 ? 'D' : 'F'}
                  successRate={workflow.success_rate ?? 0}
                  avgDurationMs={workflow.avg_duration_ms ?? 0}
                  totalCost={0}
                />
                )
              })}
            </div>
          )}
        </div>
      </div>

      <CostTrendChart data={(costDaily ?? []).map(d => ({ date: d.date, total_cost: 0, calls: d.executions }))} days={30} />
      <RecentExecutions executions={[]} />
    </div>
  )
}
