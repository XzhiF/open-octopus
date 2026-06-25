"use client"

import { cn } from "@/lib/utils"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface HeatmapCell {
  date: string
  toolName: string
  count: number
}

interface AgentHeatmapProps {
  cells: HeatmapCell[]
  days?: number
}

function intensityColor(count: number, max: number): string {
  const ratio = max > 0 ? count / max : 0
  if (ratio === 0) return "bg-muted/20"
  if (ratio < 0.25) return "bg-violet-200 dark:bg-violet-900/30"
  if (ratio < 0.5) return "bg-violet-300 dark:bg-violet-800/40"
  if (ratio < 0.75) return "bg-violet-400 dark:bg-violet-700/50"
  return "bg-violet-500 dark:bg-violet-600/60"
}

export function AgentHeatmap({ cells, days = 30 }: AgentHeatmapProps) {
  if (cells.length === 0) {
    return <div className="text-xs text-muted-foreground">暂无热力图数据</div>
  }

  const tools = [...new Set(cells.map(c => c.toolName))]
  const dates = [...new Set(cells.map(c => c.date))].sort().slice(-days)
  const maxCount = Math.max(...cells.map(c => c.count), 1)

  const cellMap = new Map<string, number>()
  for (const c of cells) cellMap.set(`${c.date}|||${c.toolName}`, c.count)

  return (
    <ChartErrorBoundary componentName="Agent 热力图">
      <div className="overflow-x-auto">
        <div className="inline-grid gap-px" style={{ gridTemplateColumns: `auto repeat(${dates.length}, minmax(20px, 1fr))` }}>
          <div />
          {dates.map(d => (
            <div key={d} className="text-[10px] text-muted-foreground text-center px-1">{d.slice(5)}</div>
          ))}
          {tools.map(tool => (
            <>
              <div key={`${tool}-label`} className="text-xs text-muted-foreground pr-2 truncate max-w-[80px]">{tool}</div>
              {dates.map(date => {
                const count = cellMap.get(`${date}|||${tool}`) ?? 0
                return (
                  <div
                    key={`${date}-${tool}`}
                    className={cn(
                      "h-5 rounded-sm transition-colors hover:ring-1 hover:ring-primary",
                      intensityColor(count, maxCount)
                    )}
                    title={`${tool} on ${date}: ${count} calls`}
                  />
                )
              })}
            </>
          ))}
        </div>
      </div>
    </ChartErrorBoundary>
  )
}
