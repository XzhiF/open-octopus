"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAnalytics } from "@/hooks/use-analytics"
import { getHealthSummary, getAlerts } from "@/lib/analytics-client"
import { AlertCard } from "./alert-card"
import { LogDrilldownDialog } from "./log-drilldown-dialog"
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart"
import type { Alert } from "@/lib/analytics-types"
import { Activity, CheckCircle2, XCircle, Clock, DollarSign } from "lucide-react"
import { formatCurrency, formatDuration, formatPercent } from "@/lib/analytics-format"

function StatCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <Card aria-label={`${label} ${value}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function OverviewTab({ workspaceId }: { workspaceId: string }) {
  const [drilldownAlert, setDrilldownAlert] = useState<Alert | null>(null)

  const { data: summary, loading: summaryLoading, error: summaryError } = useAnalytics(
    (signal) => getHealthSummary(workspaceId, signal),
    [workspaceId]
  )

  const { data: alerts, loading: alertsLoading, error: alertsError } = useAnalytics(
    (signal) => getAlerts(workspaceId, 30, 20, signal),
    [workspaceId]
  )

  if (summaryLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (summaryError) {
    return (
      <Card className="p-12 text-center border-destructive">
        <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" aria-hidden="true" />
        <p className="text-destructive font-medium mb-2">加载分析数据失败</p>
        <p className="text-sm text-muted-foreground">{summaryError}</p>
      </Card>
    )
  }

  if (!summary) {
    return (
      <Card className="p-12 text-center">
        <Activity className="h-12 w-12 mx-auto text-muted-foreground mb-4" aria-hidden="true" />
        <p className="text-muted-foreground">暂无执行数据，运行一个工作流后即可查看分析</p>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* 健康摘要统计卡 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard icon={Activity} label="总执行" value={String(summary.totalExecutions)} />
        <StatCard icon={CheckCircle2} label="成功率" value={formatPercent(summary.successRate)} />
        <StatCard icon={XCircle} label="失败率" value={formatPercent(summary.failureRate)} />
        <StatCard icon={Clock} label="平均耗时" value={formatDuration(summary.avgDurationMs)} />
        <StatCard icon={DollarSign} label="总成本" value={formatCurrency(summary.totalCostUsd)} />
      </div>

      {/* 活跃告警 */}
      {alerts && alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            活跃告警
            <span className="text-sm font-normal text-muted-foreground">({alerts.length})</span>
          </h2>
          <div className="space-y-2">
            {alerts.map(alert => (
              <AlertCard key={alert.id} alert={alert} onDrillDown={setDrilldownAlert} />
            ))}
          </div>
        </div>
      )}

      {/* 每日趋势 */}
      {summary.dailyTrend.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">执行趋势（最近 {summary.periodDays} 天）</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={{ success: { label: "成功", color: "hsl(var(--chart-1))" }, failed: { label: "失败", color: "hsl(var(--chart-5))" } }} className="h-64" aria-label={`执行趋势图：最近 ${summary.periodDays} 天`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={summary.dailyTrend}>
                  <title>执行趋势</title>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="successCount" name="成功" stackId="1" fill="var(--color-success)" stroke="var(--color-success)" fillOpacity={0.3} />
                  <Area type="monotone" dataKey="failedCount" name="失败" stackId="1" fill="var(--color-failed)" stroke="var(--color-failed)" fillOpacity={0.3} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {/* 下钻对话框 */}
      {drilldownAlert && (
        <LogDrilldownDialog
          alert={drilldownAlert}
          workspaceId={workspaceId}
          onClose={() => setDrilldownAlert(null)}
        />
      )}
    </div>
  )
}
