"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { ArrowRight, DollarSign, Calendar, TrendingUp, Database } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia, EmptyContent } from "@/components/ui/empty"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import { MemoryCostTrend } from "./memory-cost-trend"
import { WorkflowRanking } from "./workflow-ranking"
import { ExperienceList } from "./experience-list"
import { fetchArchiveStats, type ArchiveStats } from "@/lib/archive-api"

export function MemoryTab() {
  const [stats, setStats] = useState<ArchiveStats | null>(null)
  const [costDays, setCostDays] = useState(7)
  const [loading, setLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setStatsError(null)
    try {
      const result = await fetchArchiveStats()
      setStats(result)
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : "获取统计数据失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Empty state: no executions at all
  if (!loading && stats && stats.total_executions === 0) {
    return (
      <div className="space-y-6">
        <Empty className="min-h-[400px]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>暂无执行记忆</EmptyTitle>
            <EmptyDescription>
              工作流开始执行后，成本趋势、排行和经验将自动记录在此
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Stats cards skeleton */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-4 w-16 mb-2" />
                <Skeleton className="h-7 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Chart skeleton */}
        <Card>
          <CardContent className="p-4">
            <Skeleton className="h-[300px] w-full" />
          </CardContent>
        </Card>

        {/* Bottom row skeleton */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardContent className="p-4 space-y-3">
              <Skeleton className="h-5 w-24" />
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-3">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-9 w-full" />
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Stats error with retry
  if (statsError && !stats) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <p className="text-destructive">{statsError}</p>
          <button className="mt-4 text-sm text-primary underline" onClick={fetchStats}>
            重试
          </button>
        </div>
      </div>
    )
  }

  const statCards = [
    {
      title: "今日成本",
      value: stats?.today_cost_usd ?? 0,
      format: "currency" as const,
      icon: DollarSign,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
    },
    {
      title: "本周成本",
      value: stats?.week_cost_usd ?? 0,
      format: "currency" as const,
      icon: Calendar,
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
    },
    {
      title: "本月成本",
      value: stats?.month_cost_usd ?? 0,
      format: "currency" as const,
      icon: TrendingUp,
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
    },
    {
      title: "总成本",
      value: stats?.total_cost_usd ?? 0,
      format: "currency" as const,
      icon: DollarSign,
      color: "text-violet-500",
      bgColor: "bg-violet-500/10",
    },
  ]

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {statCards.map((card) => (
          <Card key={card.title}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {card.title}
                  </p>
                  <span className="text-2xl font-bold tabular-nums">
                    ${card.value.toFixed(2)}
                  </span>
                </div>
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg",
                    card.bgColor
                  )}
                >
                  <card.icon className={cn("h-4 w-4", card.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Inline error for stats if partial */}
      {statsError && stats && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm">
          <p className="text-destructive">{statsError}</p>
          <button className="text-primary underline ml-auto" onClick={fetchStats}>
            重试
          </button>
        </div>
      )}

      {/* Cost trend chart */}
      <MemoryCostTrend days={costDays} onDaysChange={setCostDays} />

      {/* Bottom row: Workflow Ranking + Experience List */}
      <div className="grid gap-6 lg:grid-cols-2">
        <WorkflowRanking />
        <ExperienceList />
      </div>

      {/* Link to full archive */}
      <div className="flex justify-center">
        <Link
          href="/archive/executions"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          查看所有执行记录
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  )
}
