"use client"

import { Clock, History, Shield } from "lucide-react"

export function EmptyScheduleList({ onCreateClick }: { onCreateClick?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Clock className="mb-4 h-12 w-12 text-muted-foreground/50" />
      <h3 className="mb-2 text-lg font-semibold">No schedules yet</h3>
      <p className="mb-4 max-w-sm text-sm text-muted-foreground">
        Create a schedule to automatically run workflows on a recurring basis.
      </p>
      {onCreateClick && (
        <button
          onClick={onCreateClick}
          className="text-sm font-medium text-primary hover:underline"
        >
          Create your first schedule
        </button>
      )}
    </div>
  )
}

export function EmptyExecutionHistory() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <History className="mb-4 h-10 w-10 text-muted-foreground/50" />
      <h3 className="mb-2 text-base font-semibold">No execution history</h3>
      <p className="max-w-xs text-sm text-muted-foreground">
        Execution records will appear here once this schedule starts triggering.
      </p>
    </div>
  )
}

export function EmptyAuditLog() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Shield className="mb-4 h-10 w-10 text-muted-foreground/50" />
      <h3 className="mb-2 text-base font-semibold">No audit logs</h3>
      <p className="max-w-xs text-sm text-muted-foreground">
        Audit log entries will appear here when schedules are created, modified, or deleted.
      </p>
    </div>
  )
}
