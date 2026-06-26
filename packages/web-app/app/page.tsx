"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import { StatsCards } from "@/components/dashboard/stats-cards"
import { HeroMetrics } from "@/components/dashboard/hero-metrics"
import { QueuePanel } from "@/components/dashboard/queue-panel"
import { RecentExecutions } from "@/components/dashboard/recent-executions"
import { LeaderboardSection } from "@/components/dashboard/leaderboard-section"
import { WorkflowHealthCard } from "@/components/dashboard/workflow-health-card"
import { MemoryTab } from "@/components/dashboard/memory-tab"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { fetchDashboardStats, fetchRunningQueue, fetchRecentExecutions, fetchWorkflowHealth } from "@/lib/api-client"
import type { Execution } from "@/lib/types"

interface WorkflowHealth {
  workflow_ref: string
  executions: number
  success_rate: number | null
  avg_duration_ms: number | null
}

function TabQueryParam({ children }: { children: (tab: string) => React.ReactNode }) {
  const searchParams = useSearchParams()
  const tab = searchParams.get("tab") === "memory" ? "memory" : "overview"
  return <>{children(tab)}</>
}

function DashboardTabs({
  stats,
  runningExecutions,
  pendingExecutions,
  recentExecutions,
  workflows,
}: {
  stats: {
    total_workspaces: number
    total_workflows: number
    total_executions: number
    completed_executions: number
    failed_executions: number
    running_executions: number
    pending_executions: number
    avg_duration_ms: number | null
    total_cost: number
  }
  runningExecutions: Execution[]
  pendingExecutions: Execution[]
  recentExecutions: Execution[]
  workflows: WorkflowHealth[]
}) {
  const dashboardStats = {
    activeWorkspaces: stats.total_workspaces,
    totalWorkspaces: stats.total_workspaces,
    runningExecutions: stats.running_executions,
    pendingExecutions: stats.pending_executions ?? 0,
    completedToday: stats.completed_executions ?? stats.total_executions,
    failedToday: stats.failed_executions ?? 0,
  }

  const totalExecutions = stats.total_executions
  const completedCount = stats.completed_executions ?? stats.total_executions
  const successRate = totalExecutions > 0 ? completedCount / totalExecutions : 0

  return (
    <Suspense fallback={<Tabs defaultValue="overview" className="gap-6"><TabsList><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="memory">执行记忆</TabsTrigger></TabsList></Tabs>}>
      <TabQueryParam>
        {(initialTab) => (
          <Tabs defaultValue={initialTab} className="gap-6">
            <TabsList>
              <TabsTrigger value="overview">概览</TabsTrigger>
              <TabsTrigger value="memory">执行记忆</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="flex flex-col gap-6">
              <StatsCards stats={dashboardStats} />
              <HeroMetrics
                totalExecutions={totalExecutions}
                successRate={successRate}
                totalCost={stats.total_cost ?? 0}
                avgDurationMs={stats.avg_duration_ms ?? 0}
              />
              <LeaderboardSection />
              {workflows.length > 0 && (
                <div>
                  <h2 className="text-xl font-semibold mb-4">Workflow 健康度</h2>
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {workflows.map((w) => (
                      <WorkflowHealthCard
                        key={w.workflow_ref}
                        workflowRef={w.workflow_ref}
                        healthScore={w.success_rate ? Math.round(w.success_rate * 100) : 0}
                        grade={w.success_rate && w.success_rate > 0.9 ? 'A' : w.success_rate && w.success_rate > 0.75 ? 'B' : w.success_rate && w.success_rate > 0.6 ? 'C' : w.success_rate && w.success_rate > 0.4 ? 'D' : 'F'}
                        successRate={w.success_rate ?? 0}
                        avgDurationMs={w.avg_duration_ms ?? 0}
                        totalCost={0}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-6 lg:grid-cols-2 items-stretch max-h-[400px]">
                <QueuePanel
                  runningExecutions={runningExecutions}
                  pendingExecutions={pendingExecutions}
                />
                <RecentExecutions executions={recentExecutions} />
              </div>
            </TabsContent>

            <TabsContent value="memory">
              <MemoryTab />
            </TabsContent>
          </Tabs>
        )}
      </TabQueryParam>
    </Suspense>
  )
}

export default function DashboardPage() {
  const [stats, setStats] = useState({
    total_workspaces: 0,
    total_workflows: 0,
    total_executions: 0,
    completed_executions: 0,
    failed_executions: 0,
    running_executions: 0,
    pending_executions: 0,
    avg_duration_ms: null as number | null,
    total_cost: 0,
  })
  const [runningExecutions, setRunningExecutions] = useState<Execution[]>([])
  const [pendingExecutions, setPendingExecutions] = useState<Execution[]>([])
  const [recentExecutions, setRecentExecutions] = useState<Execution[]>([])
  const [workflows, setWorkflows] = useState<WorkflowHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsResult, queueResult, recentResult, healthResult] = await Promise.allSettled([
        fetchDashboardStats(),
        fetchRunningQueue(),
        fetchRecentExecutions(),
        fetchWorkflowHealth(),
      ])
      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value)
      } else {
        setStats({ total_workspaces: 0, total_workflows: 0, total_executions: 0, completed_executions: 0, failed_executions: 0, running_executions: 0, pending_executions: 0, avg_duration_ms: null, total_cost: 0 })
      }
      if (queueResult.status === "fulfilled") {
        const allQueue = Array.isArray(queueResult.value) ? queueResult.value : []
        setRunningExecutions(allQueue.filter((e: Execution) => e.status === "running"))
        setPendingExecutions(allQueue.filter((e: Execution) => e.status === "pending"))
      }
      if (recentResult.status === "fulfilled") {
        setRecentExecutions(Array.isArray(recentResult.value) ? recentResult.value : [])
      }
      if (healthResult.status === "fulfilled") {
        setWorkflows(Array.isArray(healthResult.value) ? healthResult.value : [])
      }

      if (statsResult.status === "rejected" && queueResult.status === "rejected" && recentResult.status === "rejected" && healthResult.status === "rejected") {
        setError("获取数据失败")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取数据失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="container mx-auto flex items-center justify-center px-4 py-12 lg:px-6">
        <p className="text-muted-foreground">加载中...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">工作流编排平台概览</p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <p className="text-destructive">{error}</p>
          <button className="mt-4 text-sm text-primary underline" onClick={fetchData}>重试</button>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          工作流编排平台概览
        </p>
      </div>

      <DashboardTabs
        stats={stats}
        runningExecutions={runningExecutions}
        pendingExecutions={pendingExecutions}
        recentExecutions={recentExecutions}
        workflows={workflows}
      />
    </div>
  )
}
