import { GitBranch, Bot, Cog } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { JobType } from "@octopus/shared"

interface JobTypeBadgeProps {
  /** ADR-0021 票03 widened JobType with 'job' — a row that runs a registered
   *  TypeScript handler (the built-in 系统 · 任务生命周期 is one). It is a normal
   *  row of the same table, so it must render, not be filtered out. */
  type: JobType
}

export function JobTypeBadge({ type }: JobTypeBadgeProps) {
  if (type === "workflow") {
    return (
      <Badge
        className={cn(
          "bg-scheduler-primary/15 text-scheduler-primary border-scheduler-primary/30"
        )}
      >
        <GitBranch className="size-3" />
        Workflow
      </Badge>
    )
  }

  if (type === "job") {
    return (
      <Badge
        className={cn(
          "bg-scheduler-info/15 text-scheduler-info border-scheduler-info/30"
        )}
      >
        <Cog className="size-3" />
        Job
      </Badge>
    )
  }

  return (
    <Badge
      className={cn(
        "bg-scheduler-accent/15 text-scheduler-accent border-scheduler-accent/30"
      )}
    >
      <Bot className="size-3" />
      Agent
    </Badge>
  )
}
