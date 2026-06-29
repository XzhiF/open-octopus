"use client"

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import { formatCostUSD } from "@/lib/cost-format"
import type { CostTrendPoint } from "@/lib/archive-api"
import { RefreshCw } from "lucide-react"

interface CostTrendSectionProps {
  trends: CostTrendPoint[]
  loading: boolean
  error: Error | null
  days: number
  onDaysChange: (days: number) => void
  onRetry: () => void
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; payload: CostTrendPoint }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm text-xs">
      <p className="font-medium">{label}</p>
      <p className="text-memory-cost-line">{formatCostUSD(payload[0]?.value ?? 0)}</p>
      <p className="text-muted-foreground">{payload[0]?.payload?.execution_count ?? 0} 次执行</p>
    </div>
  )
}

export function CostTrendSection({ trends, loading, error, days, onDaysChange, onRetry }: CostTrendSectionProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">成本趋势</h3>
        <ToggleGroup
          type="single"
          value={String(days)}
          onValueChange={v => { if (v) onDaysChange(Number(v)) }}
          size="sm"
        >
          <ToggleGroupItem value="7">7天</ToggleGroupItem>
          <ToggleGroupItem value="30">30天</ToggleGroupItem>
          <ToggleGroupItem value="90">90天</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {loading && (
        <div className="h-[300px] rounded bg-muted animate-pulse" aria-busy="true" aria-label="加载中" />
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center h-[300px] text-center">
          <p className="text-sm text-destructive">成本趋势数据加载失败</p>
          <button onClick={onRetry} className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <RefreshCw className="h-3 w-3" /> 重试
          </button>
        </div>
      )}

      {!loading && !error && (
        <ChartErrorBoundary>
          <div className="h-[300px]" role="img" aria-label={`过去 ${days} 天的执行成本趋势图`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trends}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(1)}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="total_cost_usd"
                  stroke="var(--memory-cost-line)"
                  fill="var(--memory-cost-area)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--memory-cost-line)" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartErrorBoundary>
      )}
    </div>
  )
}
