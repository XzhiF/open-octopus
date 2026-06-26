"use client"

import { useState, useEffect } from "react"
import { Database } from "lucide-react"
import { ArchiveStatsCards } from "./archive-stats-cards"
import { ArchiveCostTrend } from "./archive-cost-trend"
import { WorkflowRankingCards } from "./workflow-ranking-cards"
import { ExecutionLeaderboard } from "./execution-leaderboard"
import { ArchiveExecutionTable } from "./archive-execution-table"
import { ExperienceSearch } from "./experience-search"
import {
  fetchArchiveStats,
  fetchCostTrends,
  fetchWorkflowStats,
  fetchArchiveLeaderboard,
  fetchArchiveExecutions,
  searchLessons,
} from "@/lib/archive-api"
import type {
  ArchiveStats,
  LeaderboardResponse,
  WorkflowStat,
} from "@octopus/shared"

export function MemoryTab() {
  const [stats, setStats] = useState<ArchiveStats | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowStat[]>([])
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)
  const [globalError, setGlobalError] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadAll() {
      const results = await Promise.allSettled([
        fetchArchiveStats(),
        fetchCostTrends("7d"),
        fetchWorkflowStats(20),
        fetchArchiveLeaderboard(5),
        fetchArchiveExecutions({ page: 1, pageSize: 20 }),
        searchLessons({ limit: 20 }),
      ])

      if (cancelled) return

      // Stats
      if (results[0].status === "fulfilled") {
        setStats(results[0].value)
      }
      setStatsLoading(false)

      // Workflow stats
      if (results[2].status === "fulfilled") {
        setWorkflows(results[2].value)
      }
      setWorkflowsLoading(false)

      // Leaderboard
      if (results[3].status === "fulfilled") {
        setLeaderboard(results[3].value)
      }
      setLeaderboardLoading(false)

      // Check if ALL requests failed
      const allFailed = results.every((r) => r.status === "rejected")
      if (allFailed) {
        setGlobalError(true)
      }
    }

    loadAll()
    return () => { cancelled = true }
  }, [])

  // Empty state
  if (!statsLoading && stats && stats.total_executions === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-24 text-center" role="region" aria-label="执行记忆">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Database className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium">暂无执行数据</h3>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          运行工作流后，执行结果会自动归档并在此展示。
        </p>
      </div>
    )
  }

  // Global error (all requests failed)
  if (globalError && !statsLoading && !workflowsLoading && !leaderboardLoading) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-24 text-center" role="region" aria-label="执行记忆">
        <p className="text-sm text-destructive">获取数据失败，请稍后重试</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" role="region" aria-label="执行记忆">
      {/* 1. Stats Cards */}
      <ArchiveStatsCards stats={stats} loading={statsLoading} />

      {/* 2. Cost Trend (self-fetching) */}
      <ArchiveCostTrend />

      {/* 3. Workflow Ranking + Leaderboard grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        <WorkflowRankingCards workflows={workflows} loading={workflowsLoading} />
        <ExecutionLeaderboard data={leaderboard} loading={leaderboardLoading} />
      </div>

      {/* 4. Archive Execution Table */}
      <ArchiveExecutionTable />

      {/* 5. Experience Search */}
      <ExperienceSearch />
    </div>
  )
}
