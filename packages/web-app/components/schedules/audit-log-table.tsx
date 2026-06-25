"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { ScheduleAuditLog } from "@/lib/types"
import { EmptyAuditLog } from "./empty-states"
import { Info } from "lucide-react"

interface Props {
  logs: ScheduleAuditLog[]
  loading: boolean
}

const ACTION_LABELS: Record<ScheduleAuditLog["action"], string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  enabled: "Enabled",
  disabled: "Disabled",
  emergency_stop: "Emergency Stop",
}

const ACTION_VARIANTS: Record<ScheduleAuditLog["action"], "default" | "secondary" | "destructive" | "outline"> = {
  created: "default",
  updated: "outline",
  deleted: "destructive",
  enabled: "default",
  disabled: "secondary",
  emergency_stop: "destructive",
}

export function AuditLogTable({ logs, loading }: Props) {
  if (!loading && logs.length === 0) {
    return <EmptyAuditLog />
  }

  return (
    <TooltipProvider>
      <Table aria-label="Schedule audit log">
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead className="w-[60px]">Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log) => (
            <TableRow key={log.id}>
              <TableCell className="text-sm">
                {new Date(log.created_at).toLocaleString()}
              </TableCell>
              <TableCell>
                <Badge variant={ACTION_VARIANTS[log.action]}>
                  {ACTION_LABELS[log.action]}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {log.actor_name}
              </TableCell>
              <TableCell className="text-sm">
                {log.schedule_name ?? "-"}
              </TableCell>
              <TableCell>
                {log.changes && Object.keys(log.changes).length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="rounded p-1 hover:bg-muted" aria-label={`View changes for ${log.schedule_name}`}>
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs">
                      <pre className="whitespace-pre-wrap text-xs">
                        {JSON.stringify(log.changes, null, 2)}
                      </pre>
                    </TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>
  )
}
