"use client"

import { Activity, CheckCircle2, Clock, Coins } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDuration } from "@/lib/format"
import type { ArchiveStats } from "@octopus/shared"

interface ArchiveStatsCardsProps {
  stats: ArchiveStats | null
  loading?: boolean
}

const cards = [
  {
    title: "Total Executions",
    key: "total" as const,
    icon: Activity,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
  },
  {
    title: "Success Rate",
    key: "rate" as const,
    icon: CheckCircle2,
    color: "text-emerald-500",
    bgColor: "bg-emerald-500/10",
  },
  {
    title: "Total Cost",
    key: "cost" as const,
    icon: Coins,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
  },
  {
    title: "Avg Duration",
    key: "duration" as const,
    icon: Clock,
    color: "text-purple-500",
    bgColor: "bg-purple-500/10",
  },
]

function getValue(stats: ArchiveStats, key: (typeof cards)[number]["key"]): string {
  if (key === "total") return String(stats.total_executions)
  if (key === "rate") return `${(stats.success_rate * 100).toFixed(1)}%`
  if (key === "cost") return stats.total_cost_display
  if (key === "duration") return formatDuration(stats.avg_duration_ms ? stats.avg_duration_ms / 1000 : undefined)
  return "-"
}

export function ArchiveStatsCards({ stats, loading }: ArchiveStatsCardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {cards.map((c) => (
          <Skeleton key={c.title} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <Card key={c.title} className="relative overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{c.title}</p>
                  <span className="text-2xl font-bold tabular-nums">
                    {stats ? getValue(stats, c.key) : "0"}
                  </span>
                </div>
                <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${c.bgColor}`}>
                  <Icon className={`h-4 w-4 ${c.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
