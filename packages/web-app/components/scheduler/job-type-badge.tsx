import { GitBranch, Bot } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { SchedulerJob } from "@/lib/scheduler-api"

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

/**
 * Check whether a scheduler job was registered by an agent via
 * `POST /api/agent/schedules/register` rather than through the UI.
 *
 * TODO: When the backend adds a `created_by` or `source` field to
 * SchedulerJob, this helper should check that field instead.
 * For now we use a heuristic: job_type === "agent" AND the job
 * carries a `workflow_ref` (set by the agent registration endpoint).
 */
export function isAgentRegistered(job: SchedulerJob): boolean {
  if (job.job_type !== "agent") return false
  // The agent registration endpoint may attach workflow_ref to the
  // job payload even though it isn't declared in the SchedulerJob type.
  return typeof (job as unknown as Record<string, unknown>).workflow_ref === "string"
}

/** Small outline badge shown next to the job name for agent-registered tasks. */
export function AgentRegisteredBadge() {
  return (
    <Badge
      variant="outline"
      className="text-scheduler-accent border-scheduler-accent/40 text-[10px] px-1.5 py-0 font-normal"
    >
      Agent 注册
    </Badge>
  )
}
