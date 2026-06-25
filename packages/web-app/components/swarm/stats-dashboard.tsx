"use client"

import { useEffect, useState } from "react"
import { fetchSwarmStats } from "@/lib/api-client"
import { MetricCard } from "./atoms/metric-card"
import {
  BarChart3,
  CheckCircle,
  Clock,
  Coins,
  PieChart,
  TrendingUp,
} from "lucide-react"
import type { SwarmStatsResponse } from "@/lib/swarm-types"

export interface StatsDashboardProps {
  workspaceId: string
  from?: string
  to?: string
}

export function StatsDashboard({ workspaceId, from, to }: StatsDashboardProps) {
  const [stats, setStats] = useState<SwarmStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchSwarmStats(workspaceId, { from, to })
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "获取统计失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceId, from, to])

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="h-16 rounded-md bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        {error || "暂无 swarm 执行数据"}
      </div>
    )
  }

  if (stats.total_executions === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        暂无 swarm 执行数据
      </div>
    )
  }

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    const s = ms / 1000
    if (s < 60) return `${s.toFixed(1)}s`
    return `${(s / 60).toFixed(1)}min`
  }

  const formatTokens = (n: number) => {
    if (n < 1000) return String(Math.round(n))
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
    return `${(n / 1_000_000).toFixed(1)}M`
  }

  const modeEntries = Object.entries(stats.mode_distribution).filter(([, v]) => v > 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <MetricCard
          label="总执行"
          value={stats.total_executions}
          icon={BarChart3}
        />
        <MetricCard
          label="成功率"
          value={`${(stats.success_rate * 100).toFixed(1)}%`}
          icon={CheckCircle}
        />
        <MetricCard
          label="平均耗时"
          value={formatMs(stats.avg_duration_ms)}
          icon={Clock}
        />
        <MetricCard
          label="平均 Token"
          value={formatTokens(stats.avg_token_consumed)}
          icon={Coins}
        />
        <MetricCard
          label="平均轮次"
          value={stats.avg_rounds.toFixed(1)}
          icon={TrendingUp}
        />
      </div>

      {stats.avg_consensus_score != null && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>平均共识分: {stats.avg_consensus_score.toFixed(3)}</span>
          {stats.router_accuracy != null && (
            <span> · Router 准确率: {(stats.router_accuracy * 100).toFixed(1)}%</span>
          )}
        </div>
      )}

      {modeEntries.length > 0 && (
        <div className="flex items-center gap-3 text-xs">
          <PieChart className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">模式分布:</span>
          {modeEntries.map(([mode, count]) => (
            <span key={mode} className="font-medium">
              {mode} {count}
            </span>
          ))}
        </div>
      )}

      {stats.top_roles.length > 0 && (
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <span className="text-muted-foreground">热门角色:</span>
          {stats.top_roles.slice(0, 5).map(({ role, count }) => (
            <span key={role} className="rounded-full border border-border px-2 py-0.5">
              {role} ({count})
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
