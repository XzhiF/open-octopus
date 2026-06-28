"use client"

import { useState, useEffect } from "react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Area,
} from "recharts"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChartContainer,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { fetchCostTrends, type CostTrendPoint, type CostTrendSummary } from "@/lib/archive-api"

interface MemoryCostTrendProps {
  days: number
  onDaysChange: (days: number) => void
  workspaceId?: string
}

const chartConfig = {
  cost: {
    label: "成本",
    color: "var(--memory-cost-line, oklch(0.65 0.2 250))",
  },
} satisfies ChartConfig

export function MemoryCostTrend({ days, onDaysChange, workspaceId }: MemoryCostTrendProps) {
  const [trends, setTrends] = useState<CostTrendPoint[]>([])
  const [summary, setSummary] = useState<CostTrendSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchCostTrends(days, workspaceId)
        if (!cancelled) {
          setTrends(result.trends)
          setSummary(result.summary)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "获取成本趋势失败")
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [days, workspaceId])

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-8 w-28" />
          </div>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            className="text-sm text-primary underline"
            onClick={() => { setLoading(true); setError(null) }}
          >
            重试
          </button>
        </CardContent>
      </Card>
    )
  }

  const TrendIcon = summary?.trend === "up"
    ? TrendingUp
    : summary?.trend === "down"
      ? TrendingDown
      : Minus

  const trendColor = summary?.trend === "up"
    ? "text-destructive"
    : summary?.trend === "down"
      ? "text-emerald-500"
      : "text-muted-foreground"

  const chartData = trends.map((t) => ({
    date: t.date.slice(5), // MM-DD
    cost: t.total_cost_usd,
  }))

  return (
    <ChartErrorBoundary componentName="成本趋势图">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">成本趋势</h3>
              {summary && (
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-lg font-bold tabular-nums">
                    ${summary.total_cost_usd.toFixed(2)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    日均 ${summary.avg_daily_cost_usd.toFixed(2)}
                  </span>
                  <TrendIcon className={cn("h-4 w-4", trendColor)} />
                </div>
              )}
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={String(days)}
              onValueChange={(v) => { if (v) onDaysChange(Number(v)) }}
            >
              <ToggleGroupItem value="7" aria-label="7天">7天</ToggleGroupItem>
              <ToggleGroupItem value="30" aria-label="30天">30天</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {chartData.length === 0 ? (
            <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
              暂无成本数据
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="h-[300px] w-full">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => `$${v.toFixed(1)}`}
                  className="fill-muted-foreground"
                  width={50}
                />
                <Tooltip content={<ChartTooltipContent />} />
                <defs>
                  <linearGradient id="costAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--memory-cost-area, oklch(0.65 0.2 250))" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--memory-cost-area, oklch(0.65 0.2 250))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="cost"
                  fill="url(#costAreaGradient)"
                  stroke="none"
                />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="var(--memory-cost-line, oklch(0.65 0.2 250))"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2 }}
                  name="成本"
                />
              </LineChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </ChartErrorBoundary>
  )
}
