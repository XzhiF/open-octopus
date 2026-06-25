"use client"

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface ExecutionHistogramProps {
  durations: number[] // milliseconds
}

function computeBins(data: number[]): { min: number; max: number; binWidth: number } {
  if (data.length === 0) return { min: 0, max: 1000, binWidth: 100 }
  const sorted = [...data].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]
  const q3 = sorted[Math.floor(sorted.length * 0.75)]
  const iqr = q3 - q1 || 1
  const binWidth = 2 * iqr / Math.cbrt(sorted.length) || 1000
  return { min: Math.floor(sorted[0] / binWidth) * binWidth, max: sorted[sorted.length - 1], binWidth }
}

export function ExecutionHistogram({ durations }: ExecutionHistogramProps) {
  if (durations.length === 0) {
    return <div className="text-sm text-muted-foreground">暂无数据</div>
  }

  const { min, max, binWidth } = computeBins(durations)
  const bins: Record<number, number> = {}
  for (let b = min; b <= max; b += binWidth) {
    bins[b] = 0
  }
  for (const d of durations) {
    const binKey = Math.floor(d / binWidth) * binWidth
    bins[binKey] = (bins[binKey] ?? 0) + 1
  }

  const chartData = Object.entries(bins)
    .filter(([, count]) => count > 0)
    .map(([bin, count]) => ({ bin: `${(Number(bin) / 1000).toFixed(0)}s`, count }))

  const sorted = [...durations].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const p99 = sorted[Math.floor(sorted.length * 0.99)]

  return (
    <ChartErrorBoundary componentName="执行时间直方图">
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <XAxis dataKey="bin" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            <ReferenceLine x={`${(p50 / 1000).toFixed(0)}s`} stroke="#10b981" strokeDasharray="3 3" label={{ value: "P50", position: "top", fontSize: 9, fill: "#10b981" }} />
            <ReferenceLine x={`${(p90 / 1000).toFixed(0)}s`} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: "P90", position: "top", fontSize: 9, fill: "#f59e0b" }} />
            <ReferenceLine x={`${(p99 / 1000).toFixed(0)}s`} stroke="#ef4444" strokeDasharray="3 3" label={{ value: "P99", position: "top", fontSize: 9, fill: "#ef4444" }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartErrorBoundary>
  )
}
