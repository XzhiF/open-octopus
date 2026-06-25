"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertOctagon, AlertTriangle } from "lucide-react"
import { formatCurrency } from "@/lib/analytics-format"
import type { DurationAnomaly, ConsecutiveFailure, CostAnomaly } from "@/lib/analytics-types"

interface AnomalyTimelineProps {
  durationAnomalies: DurationAnomaly[]
  consecutiveFailures: ConsecutiveFailure[]
  costAnomalies: CostAnomaly[]
}

type TimelineEvent = {
  timestamp: string
  severity: "critical" | "warning"
  description: string
}

export function AnomalyTimeline({ durationAnomalies, consecutiveFailures, costAnomalies }: AnomalyTimelineProps) {
  const events: TimelineEvent[] = [
    ...durationAnomalies.slice(0, 10).map(a => ({
      timestamp: "",
      severity: a.severity,
      description: `${a.nodeId} 耗时 ${(a.currentDurationMs / 1000).toFixed(0)}s (Z=${a.zScore})`,
    })),
    ...consecutiveFailures.map(c => ({
      timestamp: c.streakEnd,
      severity: c.streakLength >= 5 ? "critical" as const : "warning" as const,
      description: `${c.workflowRef} 连续失败 ${c.streakLength} 次`,
    })),
    ...costAnomalies.slice(0, 10).map(a => ({
      timestamp: "",
      severity: a.severity,
      description: `执行成本 ${formatCurrency(a.execCostUsd)} (${a.costRatio}x 均值)`,
    })),
  ]

  if (events.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">异常事件时间线</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">未检测到异常事件</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">异常事件时间线</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {events.map((event, i) => {
          const Icon = event.severity === "critical" ? AlertOctagon : AlertTriangle
          const iconColor = event.severity === "critical" ? "text-destructive" : "text-amber-500"
          return (
            <div key={i} className="flex items-center gap-3 text-sm p-2 rounded-md bg-muted/50">
              <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
              <span className="flex-1">{event.description}</span>
              {event.timestamp && <span className="text-xs text-muted-foreground">{event.timestamp.slice(0, 16)}</span>}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
