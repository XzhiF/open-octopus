"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAnalytics } from "@/hooks/use-analytics"
import { getCostAnalysis } from "@/lib/analytics-client"
import { CostTrendChart } from "./cost-trend-chart"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts"
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart"
import { XCircle, DollarSign } from "lucide-react"
import { formatCurrency } from "@/lib/analytics-format"

const MODEL_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#10b981"]

export function CostTab({ workspaceId }: { workspaceId: string }) {

  const { data, loading, error } = useAnalytics(
    (signal) => getCostAnalysis(workspaceId, 30, signal),
    [workspaceId]
  )

  if (loading) {
    return <div className="space-y-6"><Skeleton className="h-64" /><Skeleton className="h-48" /></div>
  }

  if (error) {
    return (
      <Card className="p-12 text-center border-destructive">
        <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
        <p className="text-destructive font-medium mb-2">加载成本分析数据失败</p>
        <p className="text-sm text-muted-foreground">{error}</p>
      </Card>
    )
  }

  if (!data) return null

  if (data.costTrend.length === 0 && data.costByWorkflow.length === 0) {
    return (
      <Card className="p-12 text-center">
        <DollarSign className="h-12 w-12 mx-auto text-muted-foreground mb-4" aria-hidden="true" />
        <p className="text-muted-foreground">暂无成本数据，执行工作流后可查看成本分析</p>
      </Card>
    )
  }

  const tokenChartConfig = Object.fromEntries(
    data.tokenDistribution.map((t, i) => [t.model, { label: t.model, color: MODEL_COLORS[i % MODEL_COLORS.length] }])
  )

  return (
    <div className="space-y-6">
      <CostTrendChart data={data.costTrend} days={30} />

      {/* Token 使用分布 */}
      {data.tokenDistribution.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Token 使用分布</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <ChartContainer config={tokenChartConfig} className="h-48 w-48 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={data.tokenDistribution} dataKey="totalCostUsd" nameKey="model" cx="50%" cy="50%" innerRadius={50} outerRadius={80}>
                      {data.tokenDistribution.map((_, i) => (
                        <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltipContent />} />
                  </PieChart>
                </ResponsiveContainer>
              </ChartContainer>
              <div className="flex-1 space-y-1">
                {data.tokenDistribution.map((t, i) => (
                  <div key={t.model} className="flex items-center justify-between text-sm py-1">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                      <span>{t.model}</span>
                    </div>
                    <div className="text-muted-foreground tabular-nums flex gap-4">
                      <span>{(t.totalInputTokens / 1000).toFixed(0)}K in</span>
                      <span>{(t.totalOutputTokens / 1000).toFixed(0)}K out</span>
                      <span>{formatCurrency(t.totalCostUsd)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 工作流成本排行 */}
      {data.costByWorkflow.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">工作流成本排行</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.costByWorkflow.map(wf => (
              <div key={wf.workflowRef} className="flex items-center justify-between text-sm p-2 rounded-md bg-muted/50">
                <span className="font-medium">{wf.workflowRef}</span>
                <div className="flex gap-4 text-muted-foreground tabular-nums">
                  <span>{formatCurrency(wf.totalCostUsd)}</span>
                  <span>{wf.executionCount} 次</span>
                  <span>{formatCurrency(wf.avgCostPerExecution)}/次</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
