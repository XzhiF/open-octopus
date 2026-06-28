"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useArchiveStats } from "@/hooks/use-archive-stats"
import { useCostTrends } from "@/hooks/use-cost-trends"
import { useExperienceSearch } from "@/hooks/use-experience-search"
import { getLeaderboard, type LeaderboardEntry } from "@/lib/archive-api"
import { listWorkspaces } from "@/lib/api-client"
import { formatCost } from "@/lib/cost-format"
import { CostTrendSection } from "@/components/archive/cost-trend-section"
import { WorkflowRanking } from "@/components/archive/workflow-ranking"
import { ExperienceList } from "@/components/archive/experience-list"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ArrowRight, TrendingUp, DollarSign, Calendar } from "lucide-react"
import type { Workspace } from "@/lib/types"

function MemoryStatsCards({ stats }: { stats: ReturnType<typeof useArchiveStats>["data"] }) {
  if (!stats) return null
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {[
        { label: "今日成本", value: stats.today_cost_usd, icon: DollarSign },
        { label: "本周成本", value: stats.week_cost_usd, icon: TrendingUp },
        { label: "本月成本", value: stats.month_cost_usd, icon: Calendar },
      ].map(({ label, value, icon: Icon }) => (
        <div key={label} className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon className="h-4 w-4" />
            {label}
          </div>
          <p className="mt-1 text-2xl font-bold">{formatCost(value)}</p>
        </div>
      ))}
    </div>
  )
}

export function MemoryTab() {
  const { data: stats, loading: statsLoading, error: statsError, refetch: refetchStats } = useArchiveStats()
  const [days, setDays] = useState(7)
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  const { trends, loading: trendsLoading, error: trendsError, refetch: refetchTrends } = useCostTrends(days, workspaceId)
  const { query, lessons, total, loading: lessonsLoading, search } = useExperienceSearch("", 10)

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [leaderboardBy, setLeaderboardBy] = useState<"count" | "success_rate" | "cost">("count")
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  // Fetch workspace list for filter dropdown
  useEffect(() => {
    listWorkspaces()
      .then(data => {
        const list = Array.isArray(data) ? data : (data as any).workspaces ?? []
        setWorkspaces(list)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setLeaderboardLoading(true)
    getLeaderboard(leaderboardBy, 10)
      .then(res => setLeaderboard(res.entries))
      .catch(() => setLeaderboard([]))
      .finally(() => setLeaderboardLoading(false))
  }, [leaderboardBy])

  const isEmpty = stats?.total_executions === 0

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center" role="status">
        <TrendingUp className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium">暂无执行记录</p>
        <p className="text-sm text-muted-foreground mt-1">
          首次工作流执行完成后，数据将自动归档并显示在这里。
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Workspace Filter + Stats Cards */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <MemoryStatsCards stats={stats} />
        </div>
        <div className="shrink-0">
          <Select
            value={workspaceId ?? "all"}
            onValueChange={v => setWorkspaceId(v === "all" ? undefined : v)}
          >
            <SelectTrigger className="w-[180px]" aria-label="按工作空间过滤">
              <SelectValue placeholder="全部工作空间" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部工作空间</SelectItem>
              {workspaces.map(ws => (
                <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Cost Trend Chart */}
      <CostTrendSection
        trends={trends}
        loading={trendsLoading}
        error={trendsError}
        days={days}
        onDaysChange={setDays}
        onRetry={refetchTrends}
      />

      {/* Workflow Ranking + Experience List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <WorkflowRanking
          entries={leaderboard}
          loading={leaderboardLoading}
          sortBy={leaderboardBy}
          onSortChange={setLeaderboardBy}
        />
        <ExperienceList
          lessons={lessons}
          total={total}
          loading={lessonsLoading}
          query={query}
          onSearch={search}
        />
      </div>

      {/* Link to full archive */}
      <Link
        href="/archive/executions"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        查看所有执行记录 <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  )
}
