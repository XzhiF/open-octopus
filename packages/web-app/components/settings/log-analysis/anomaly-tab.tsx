"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAnalytics } from "@/hooks/use-analytics"
import { getAnomalies } from "@/lib/analytics-client"
import { AnomalyTimeline } from "./anomaly-timeline"
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts"
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart"
import { XCircle, CheckCircle2 } from "lucide-react"

export function AnomalyTab({ workspaceId }: { workspaceId: string }) {

  const { data, loading, error } = useAnalytics(
    (signal) => getAnomalies(workspaceId, 30, signal),
    [workspaceId]
  )

  if (loading) {
    return <div className="space-y-6"><Skeleton className="h-64" /><Skeleton className="h-48" /></div>
  }

  if (error) {
    return (
      <Card className="p-12 text-center border-destructive">
        <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
        <p className="text-destructive font-medium mb-2">加载异常检测数据失败</p>
        <p className="text-sm text-muted-foreground">{error}</p>
      </Card>
    )
  }

  if (!data) return null

  if (data.durationAnomalies.length === 0 && data.consecutiveFailures.length === 0 && data.costAnomalies.length === 0) {
    return (
      <Card className="p-12 text-center">
        <CheckCircle2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" aria-hidden="true" />
        <p className="text-muted-foreground">未发现异常，工作流运行稳定</p>
      </Card>
    )
  }

  // Prepare scatter data for duration anomalies
  const scatterData = data.durationAnomalies.map((a, i) => ({
    x: i + 1,
    y: a.currentDurationMs / 1000,
    zScore: a.zScore,
    nodeId: a.nodeId,
    severity: a.severity,
  }))

  const meanMs = data.durationAnomalies.length > 0 ? data.durationAnomalies[0].meanDurationMs / 1000 : 0
  const stddevMs = data.durationAnomalies.length > 0 ? data.durationAnomalies[0].stddevDurationMs / 1000 : 0

  return (
    <div className="space-y-6">
      {/* 耗时异常散点图 */}
      {scatterData.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">耗时异常 (Z-Score &gt; 2)</CardTitle></CardHeader>
          <CardContent>
            <ChartContainer config={{ anomaly: { label: "耗时", color: "hsl(var(--chart-1))" } }} className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="x" name="序号" tick={{ fontSize: 12 }} />
                  <YAxis dataKey="y" name="耗时(s)" tick={{ fontSize: 12 }} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <ReferenceLine y={meanMs} stroke="hsl(var(--chart-2))" strokeDasharray="3 3" label={`μ=${meanMs.toFixed(0)}s`} />
                  <ReferenceLine y={meanMs + 2 * stddevMs} stroke="hsl(var(--chart-3))" strokeDasharray="3 3" label="μ+2σ" />
                  <Scatter data={scatterData} fill="hsl(var(--chart-1))" />
                </ScatterChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {/* 连续失败 */}
      {data.consecutiveFailures.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">连续失败检测</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.consecutiveFailures.map(cf => (
              <div key={cf.workflowRef} className="flex items-center gap-3 p-2 rounded-md bg-muted/50">
                <span className="font-medium text-sm">{cf.workflowRef}</span>
                <div className="flex-1">
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-destructive rounded-full" style={{ width: `${Math.min(cf.streakLength * 15, 100)}%` }} />
                  </div>
                </div>
                <span className="text-sm tabular-nums text-destructive font-semibold">连续 {cf.streakLength} 次</span>
                <span className="text-xs text-muted-foreground">{cf.streakStart.slice(0, 10)} → {cf.streakEnd.slice(0, 10)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 异常事件时间线 */}
      <AnomalyTimeline
        durationAnomalies={data.durationAnomalies}
        consecutiveFailures={data.consecutiveFailures}
        costAnomalies={data.costAnomalies}
      />
    </div>
  )
}
