import { GitBranch, Bot } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface JobTypeBadgeProps {
  type: "workflow" | "agent"
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
