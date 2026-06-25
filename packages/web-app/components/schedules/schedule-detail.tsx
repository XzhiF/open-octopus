"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Edit, Trash2, Play } from "lucide-react"
import type { Schedule } from "@/lib/types"
import { useScheduleExecutions } from "@/hooks/use-schedule-executions"
import { ExecutionHistory } from "./execution-history"
import { MissedAlertBanner } from "./missed-alert-banner"

interface Props {
  schedule: Schedule
  wsId: string
  onToggle: (id: string, enabled: boolean) => Promise<unknown>
  onTrigger: (id: string) => Promise<unknown>
  onEdit: (schedule: Schedule) => void
  onDelete: (id: string) => void
  onBack: () => void
}

export function ScheduleDetail({
  schedule,
  wsId,
  onToggle,
  onTrigger,
  onEdit,
  onDelete,
  onBack,
}: Props) {
  const { executions, total, page, setPage, loading, retry } = useScheduleExecutions(
    wsId,
    schedule.id,
    10
  )

  return (
    <div className="space-y-6">
      {/* Missed Alert */}
      <MissedAlertBanner schedule={schedule} wsId={wsId} onDismissed={onBack} />

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={onBack}
            className="mb-2 text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; Back to list
          </button>
          <h2 className="text-xl font-semibold">{schedule.name}</h2>
          <p className="text-sm text-muted-foreground">{schedule.workflow_ref}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={schedule.enabled}
            onCheckedChange={() => onToggle(schedule.id, !schedule.enabled)}
            aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
          />
          <Button variant="outline" size="sm" onClick={() => onTrigger(schedule.id)}>
            <Play className="mr-1 h-3.5 w-3.5" />
            Trigger
          </Button>
          <Button variant="outline" size="sm" onClick={() => onEdit(schedule)}>
            <Edit className="mr-1 h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            aria-label={`Delete ${schedule.name}`}
            onClick={() => onDelete(schedule.id)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Info Grid */}
      <div className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Status</p>
          <Badge variant={schedule.enabled ? "default" : "secondary"} className="mt-1">
            {schedule.enabled ? "Active" : "Disabled"}
          </Badge>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Cron</p>
          <code className="mt-1 block text-sm">{schedule.cron_expression}</code>
          {schedule.cron_description && (
            <p className="text-xs text-muted-foreground">{schedule.cron_description}</p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Timezone</p>
          <p className="mt-1 text-sm">{schedule.timezone}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Next Run</p>
          <p className="mt-1 text-sm">
            {schedule.next_trigger_at
              ? new Date(schedule.next_trigger_at).toLocaleString()
              : "-"}
          </p>
        </div>
      </div>

      {/* Execution History */}
      <div>
        <h3 className="mb-3 text-base font-semibold">Execution History</h3>
        <ExecutionHistory
          executions={executions}
          total={total}
          page={page}
          pageSize={10}
          loading={loading}
          onPageChange={setPage}
          onRetry={retry}
        />
      </div>
    </div>
  )
}
