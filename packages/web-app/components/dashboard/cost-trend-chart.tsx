"use client"

import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface CostTrendChartProps {
  data: Array<{ date: string; total_cost: number; calls: number }>
  days: number
}

export function CostTrendChart({ data, days }: CostTrendChartProps) {
  if (data.length === 0) {
    return <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">暂无成本数据</div>
  }

  const maxCost = Math.max(...data.map(d => d.total_cost), 0.01)

  return (
    <ChartErrorBoundary componentName="成本趋势图">
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-medium mb-4">{days} 日成本趋势</h3>
        <div className="flex items-end gap-1 h-32">
          {data.map((d, i) => (
            <div
              key={d.date}
              className="flex-1 bg-blue-500/80 hover:bg-blue-500 rounded-t transition-colors relative group"
              style={{ height: `${(d.total_cost / maxCost) * 100}%`, minHeight: d.total_cost > 0 ? '4px' : '0' }}
              title={`${d.date}: $${d.total_cost.toFixed(2)} (${d.calls} calls)`}
            >
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-popover text-popover-foreground text-xs rounded shadow opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                {d.date}: ${d.total_cost.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-1 mt-1">
          {data.map(d => (
            <div key={d.date} className="flex-1 text-center text-[10px] text-muted-foreground">
              {d.date.slice(5)}
            </div>
          ))}
        </div>
      </div>
    </ChartErrorBoundary>
  )
}
