"use client"

import { ArrowUpRight, ArrowDownRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"

interface HeroMetricsProps {
  totalExecutions: number
  successRate: number
  totalCost: number
  avgDurationMs: number
  prevTotalExecutions?: number
  prevSuccessRate?: number
  prevTotalCost?: number
  prevAvgDurationMs?: number
}

function TrendBadge({ current, prev, unit = "", isDuration = false }: { current: number; prev?: number; unit?: string; isDuration?: boolean }) {
  // Format value with unit: $ is prefix, % and s are suffixes
  const formattedValue = (() => {
    if (isDuration) return formatDuration(current)
    const num = current.toFixed(unit === '$' ? 2 : 0)
    if (unit === '$') return `$${num}`
    if (unit === '%' || unit === 's') return `${num}${unit}`
    return num
  })()

  if (prev === undefined || prev === 0) return <span className="text-xs text-muted-foreground">{formattedValue}</span>

  const pct = ((current - prev) / prev) * 100
  const isPositive = current > prev
  return (
    <div className="flex items-center gap-1">
      <span className="text-lg font-bold tabular-nums">{formattedValue}</span>
      <span className={cn("flex items-center text-xs tabular-nums", isPositive ? "text-emerald-600" : "text-red-600")}>
        {isPositive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
        {Math.abs(pct).toFixed(0)}%
      </span>
    </div>
  )
}

export function HeroMetrics({ totalExecutions, successRate, totalCost, avgDurationMs, prevTotalExecutions, prevSuccessRate, prevTotalCost, prevAvgDurationMs }: HeroMetricsProps) {
  const metrics = [
    { label: "总执行", value: totalExecutions, prev: prevTotalExecutions, unit: "", isDuration: false },
    { label: "成功率", value: successRate * 100, prev: prevSuccessRate ? prevSuccessRate * 100 : undefined, unit: "%", isDuration: false },
    { label: "总成本", value: totalCost, prev: prevTotalCost, unit: "$", isDuration: false },
    { label: "平均耗时", value: avgDurationMs / 1000, prev: prevAvgDurationMs ? prevAvgDurationMs / 1000 : undefined, unit: "s", isDuration: true },
  ]

  return (
    <div data-testid="hero-metrics" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {metrics.map(m => (
        <div key={m.label} className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">{m.label}</p>
          <TrendBadge current={m.value} prev={m.prev} unit={m.unit} isDuration={m.isDuration} />
        </div>
      ))}
    </div>
  )
}
