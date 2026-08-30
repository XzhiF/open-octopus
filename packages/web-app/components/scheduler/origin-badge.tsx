// packages/web-app/components/scheduler/origin-badge.tsx
//
// 来源 (origin) badge for scheduler table rows — the authoritative
// origin_type from the schedules polymorphic origin (S2), NOT the lossy
// legacy trigger_source. 2026-08-29 (approach A): the scheduler list now
// spans all origins, so each row declares where its schedule came from.
// task-origin rows deep-link to the task board via origin_id.

import Link from "next/link"
import { Timer, KanbanSquare, Bot, Hand, Globe } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { OriginType } from "@octopus/shared"

const ORIGIN_META: Record<OriginType, { label: string; className: string; Icon: typeof Timer }> = {
  cron: {
    label: "定时",
    className: "bg-scheduler-info/15 text-scheduler-info border-scheduler-info/30",
    Icon: Timer,
  },
  task: {
    label: "任务",
    className: "bg-scheduler-primary/15 text-scheduler-primary border-scheduler-primary/30",
    Icon: KanbanSquare,
  },
  agent: {
    label: "Agent",
    className: "bg-scheduler-accent/15 text-scheduler-accent border-scheduler-accent/30",
    Icon: Bot,
  },
  manual: {
    label: "手动",
    className: "bg-muted text-muted-foreground border-border",
    Icon: Hand,
  },
  api: {
    label: "API",
    className: "bg-muted text-muted-foreground border-border",
    Icon: Globe,
  },
}

interface OriginBadgeProps {
  /** Null/undefined = legacy rows written before origin_type existed → cron. */
  originType: OriginType | null | undefined
  /** Parent object id (task id when originType='task'); enables deep-link. */
  originId?: string | null
}

export function OriginBadge({ originType, originId }: OriginBadgeProps) {
  const meta = ORIGIN_META[originType ?? "cron"] ?? ORIGIN_META.cron
  const badge = (
    <Badge className={cn("gap-1 font-normal", meta.className)} data-origin-badge={originType ?? "cron"}>
      <meta.Icon className="size-3" />
      {meta.label}
    </Badge>
  )

  if (meta === ORIGIN_META.task && originId) {
    return (
      <Link
        href={`/tasks?task=${originId}`}
        title="打开任务看板中的该任务"
        aria-label="查看来源任务"
        className="hover:opacity-80"
      >
        {badge}
      </Link>
    )
  }
  return badge
}
