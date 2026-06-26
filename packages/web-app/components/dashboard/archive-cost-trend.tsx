"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import { fetchCostTrends } from "@/lib/archive-api"
import type { CostTrendResponse } from "@octopus/shared"

export function ArchiveCostTrend() {
  const [period, setPeriod] = useState<"7d" | "30d">("7d")
  const [data, setData] = useState<CostTrendResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchCostTrends(period)
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [period])

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">成本趋势</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">成本趋势</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{error}</p>
        </CardContent>
      </Card>
    )
  }

  const points = data?.points ?? []
  const summary = data?.summary

  if (points.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">成本趋势</CardTitle>
            <PeriodToggle value={period} onChange={setPeriod} />
          </div>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">暂无成本数据</p>
        </CardContent>
      </Card>
    )
  }

  const maxCost = Math.max(...points.map((p) => p.cost_usd), 0.01)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">成本趋势</CardTitle>
          <PeriodToggle value={period} onChange={setPeriod} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChartErrorBoundary componentName="成本趋势图">
          {points.length < 2 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">数据不足</p>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {points.map((p) => (
                <div
                  key={p.date}
                  className="flex-1 bg-blue-500/80 hover:bg-blue-500 rounded-t transition-colors relative group"
                  style={{
                    height: `${(p.cost_usd / maxCost) * 100}%`,
                    minHeight: p.cost_usd > 0 ? "4px" : "0",
                  }}
                  title={`${p.date}: $${p.cost_usd.toFixed(4)} (${p.execution_count} runs)`}
                >
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-popover text-popover-foreground text-xs rounded shadow opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                    {p.date}: ${p.cost_usd.toFixed(4)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ChartErrorBoundary>

        {points.length >= 2 && (
          <div className="flex gap-1 mt-1">
            {points.map((p) => (
              <div key={p.date} className="flex-1 text-center text-[10px] text-muted-foreground">
                {p.date.slice(5)}
              </div>
            ))}
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-3 gap-4 pt-2 border-t">
            <SummaryItem label="今日" value={summary.today_cost_usd} />
            <SummaryItem label="本周" value={summary.week_cost_usd} />
            <SummaryItem label="本月" value={summary.month_cost_usd} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PeriodToggle({
  value,
  onChange,
}: {
  value: "7d" | "30d"
  onChange: (v: "7d" | "30d") => void
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as "7d" | "30d")}>
      <TabsList className="h-8">
        <TabsTrigger value="7d" className="text-xs px-3 h-6">7d</TabsTrigger>
        <TabsTrigger value="30d" className="text-xs px-3 h-6">30d</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">${value.toFixed(4)}</p>
    </div>
  )
}
