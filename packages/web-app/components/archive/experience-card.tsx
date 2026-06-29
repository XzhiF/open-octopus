"use client"

import { cn } from "@/lib/utils"
import type { ExperienceItem } from "@/lib/archive-api"
import { formatDistanceToNow } from "date-fns"
import { zhCN } from "date-fns/locale"
import { Bug, Wrench, DollarSign, AlertTriangle } from "lucide-react"
import Link from "next/link"

const typeConfig: Record<string, { icon: React.ComponentType<{ className?: string }>; colorClass: string; label: string }> = {
  bug: { icon: Bug, colorClass: "text-memory-exp-bug", label: "BUG" },
  pattern: { icon: Wrench, colorClass: "text-memory-exp-pattern", label: "模式" },
  cost: { icon: DollarSign, colorClass: "text-memory-exp-cost", label: "成本" },
  failure: { icon: AlertTriangle, colorClass: "text-memory-exp-failure", label: "故障" },
}

interface ExperienceCardProps {
  item: ExperienceItem
  expanded: boolean
  onToggle: () => void
}

export function ExperienceCard({ item, expanded, onToggle }: ExperienceCardProps) {
  const config = typeConfig[item.type] ?? typeConfig.pattern
  const Icon = config.icon
  const timeAgo = formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: zhCN })

  return (
    <div className="rounded-md border">
      <button
        className="w-full text-left p-3 flex items-start gap-2 hover:bg-accent/30 transition-colors"
        onClick={onToggle}
      >
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", config.colorClass)} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{item.title}</p>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            {item.workflow_name && <span>{item.workflow_name}</span>}
            <span>{timeAgo}</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t pt-2">
          <p className="text-sm text-foreground whitespace-pre-wrap">{item.content}</p>
          {item.archive_id && (
            <Link
              href={`/archive/executions/${item.archive_id}`}
              className="text-xs text-primary hover:underline mt-2 inline-block"
            >
              查看来源执行 →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
