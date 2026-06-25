"use client"

import { useState, useEffect } from "react"
import { Activity, TrendingUp, TrendingDown, Minus, AlertTriangle, Clock } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { DashboardCardsSkeleton } from "./skeleton-loader"
import { cn } from "@/lib/utils"
import type { DashboardSummary, TrendDirection } from "@/lib/scheduler-api"

interface DashboardCardsProps {
  data: DashboardSummary | null
  loading?: boolean
}

function TrendIcon({ direction }: { direction: TrendDirection }) {
  switch (direction) {
    case "up":
      return <TrendingUp className="size-3.5 text-scheduler-success" />
    case "down":
      return <TrendingDown className="size-3.5 text-scheduler-error" />
    default:
      return <Minus className="size-3.5 text-muted-foreground" />
  }
}

function CountdownDisplay({ triggerAt }: { triggerAt: string }) {
  const [remaining, setRemaining] = useState("")

  useEffect(() => {
    const update = () => {
      const diff = new Date(triggerAt).getTime() - Date.now()
      if (diff <= 0) {
        setRemaining("即将触发")
        return
      }
      const hours = Math.floor(diff / 3_600_000)
      const minutes = Math.floor((diff % 3_600_000) / 60_000)
      const seconds = Math.floor((diff % 60_000) / 1_000)
      setRemaining(
        hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}m ${seconds}s`
      )
    }

    update()
    const timer = setInterval(update, 1_000)
    return () => clearInterval(timer)
  }, [triggerAt])

  return <span>{remaining}</span>
}

export function DashboardCards({ data, loading }: DashboardCardsProps) {
  if (loading || !data) {
    return <DashboardCardsSkeleton />
  }

  const cards = [
    {
      label: "活跃任务",
      value: String(data.total_active),
      icon: <Activity className="size-5 text-scheduler-primary" />,
      sub: "当前已启用的调度任务",
    },
    {
      label: "成功率",
      value:
        data.success_rate?.value != null
          ? `${data.success_rate.value}%`
          : "-",
      icon: <TrendingUp className="size-5 text-scheduler-success" />,
      sub:
        data.success_rate?.trend_delta != null ? (
          <span className="flex items-center gap-1">
            <TrendIcon direction={data.success_rate.trend} />
            {data.success_rate.trend_delta > 0 ? "+" : ""}
            {data.success_rate.trend_delta}%
          </span>
        ) : (
          "近期无数据"
        ),
    },
    {
      label: "失败任务",
      value: String(data.failed_count),
      icon: (
        <AlertTriangle
          className={cn(
            "size-5",
            data.failed_count > 0
              ? "text-scheduler-error"
              : "text-muted-foreground"
          )}
        />
      ),
      sub:
        data.failed_count > 0
          ? "需要关注"
          : "一切正常",
    },
    {
      label: "下次触发",
      value: data.next_trigger ? (
        <CountdownDisplay triggerAt={data.next_trigger.trigger_at} />
      ) : (
        "-"
      ),
      icon: <Clock className="size-5 text-scheduler-info" />,
      sub: data.next_trigger?.schedule_name ?? "暂无计划",
    },
  ]

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      aria-label="调度概览"
    >
      {cards.map((card) => (
        <Card key={card.label} className="gap-0 py-0">
          <CardContent className="flex items-start gap-4 p-5">
            <div className="shrink-0 rounded-lg bg-muted p-2.5">
              {card.icon}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground mb-1">
                {card.label}
              </p>
              <p className="text-2xl font-semibold tracking-tight leading-none mb-1.5">
                {card.value}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {card.sub}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
