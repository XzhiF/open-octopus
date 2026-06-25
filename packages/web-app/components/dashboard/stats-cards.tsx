import { Card, CardContent } from "@/components/ui/card"
import type { DashboardStats } from "@/lib/types"
import {
  FolderKanban,
  Play,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react"

interface StatsCardsProps {
  stats: DashboardStats
}

export function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      title: "活跃工作空间",
      value: stats.activeWorkspaces,
      total: stats.totalWorkspaces,
      icon: FolderKanban,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
    },
    {
      title: "运行中任务",
      value: stats.runningExecutions,
      icon: Play,
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
      pulse: stats.runningExecutions > 0,
    },
    {
      title: "待开始",
      value: stats.pendingExecutions,
      icon: Clock,
      color: "text-muted-foreground",
      bgColor: "bg-muted",
    },
    {
      title: "总完成",
      value: stats.completedToday,
      icon: CheckCircle2,
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
    },
    {
      title: "总失败",
      value: stats.failedToday,
      icon: XCircle,
      color: "text-destructive",
      bgColor: "bg-destructive/10",
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <Card key={card.title} className="relative overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {card.title}
                </p>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold tabular-nums">
                    {card.value}
                  </span>
                  {card.total !== undefined && (
                    <span className="text-sm text-muted-foreground">
                      / {card.total}
                    </span>
                  )}
                </div>
              </div>
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-lg ${card.bgColor}`}
              >
                <card.icon className={`h-4 w-4 ${card.color}`} />
              </div>
            </div>
            {card.pulse && (
              <div className="absolute top-2 right-2">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
