"use client"

import { useMemo } from "react"

interface CostWaterfallProps {
  models: Array<{
    model: string
    total_cost: number
    calls: number
    input_tokens: number
    output_tokens: number
  }>
  height?: number
}

export function CostWaterfall({ models, height = 240 }: CostWaterfallProps) {
  const bars = useMemo(() => {
    if (!models.length) return []
    const maxCost = Math.max(...models.map((m) => m.total_cost), 0.01)
    const sorted = [...models].sort((a, b) => b.total_cost - a.total_cost)
    return sorted.map((m) => ({
      ...m,
      pct: (m.total_cost / maxCost) * 100,
      pctTotal: maxCost > 0 ? (m.total_cost / models.reduce((s, x) => s + x.total_cost, 0)) * 100 : 0,
    }))
  }, [models])

  if (!bars.length) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        暂无成本数据
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="h-2 w-2 rounded-full bg-blue-500" />
        <span className="text-sm font-medium">成本瀑布图</span>
        <span className="ml-auto text-xs text-muted-foreground">
          ${bars.reduce((s, b) => s + b.total_cost, 0).toFixed(2)} 总计
        </span>
      </div>

      <div className="space-y-2" style={{ height }}>
        {bars.map((bar, i) => (
          <div key={bar.model} className="flex items-center gap-3 group">
            <span className="w-24 truncate text-xs font-mono text-muted-foreground" title={bar.model}>
              {bar.model}
            </span>
            <div className="flex-1 relative h-6 rounded bg-secondary/50 overflow-hidden">
              <div
                className="h-full rounded transition-all duration-500"
                style={{
                  width: `${bar.pct}%`,
                  background: `hsl(${i * 45 + 200}, 70%, 50%)`,
                }}
              />
              <span className="absolute inset-0 flex items-center px-2 text-xs text-white/80 font-medium truncate">
                ${bar.total_cost.toFixed(2)} ({bar.pctTotal.toFixed(1)}%)
              </span>
            </div>
            <span className="w-12 text-right text-xs text-muted-foreground">{bar.calls} calls</span>
          </div>
        ))}
      </div>
    </div>
  )
}
