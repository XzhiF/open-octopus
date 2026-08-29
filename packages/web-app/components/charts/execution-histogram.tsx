"use client"

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface ExecutionHistogramProps {
  durations: number[] // milliseconds
}

// fmt-ok: recharts 轴刻度用「整秒数」紧凑标度（30s/60s），与 formatDuration 的
// 阅读文案（1m 0s）是两种用途——轴标签要求等宽短标度，豁免全站时长单源。
const fmtAxisSec = (ms: number) => `${(ms / 1000).toFixed(0)}s` // fmt-ok: 轴刻度 helper

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
    .map(([bin, count]) => ({ bin: fmtAxisSec(Number(bin)), count }))

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
            <ReferenceLine x={fmtAxisSec(p50)} stroke="#10b981" strokeDasharray="3 3" label={{ value: "P50", position: "top", fontSize: 9, fill: "#10b981" }} />
            <ReferenceLine x={fmtAxisSec(p90)} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: "P90", position: "top", fontSize: 9, fill: "#f59e0b" }} />
            <ReferenceLine x={fmtAxisSec(p99)} stroke="#ef4444" strokeDasharray="3 3" label={{ value: "P99", position: "top", fontSize: 9, fill: "#ef4444" }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartErrorBoundary>
  )
}
