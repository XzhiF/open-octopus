"use client"

import { useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MoreHorizontal, Play, Edit, Trash2, AlertTriangle } from "lucide-react"
import type { Schedule } from "@/lib/types"
import { EmptyScheduleList } from "./empty-states"

interface Props {
  schedules: Schedule[]
  loading: boolean
  onToggle: (id: string, enabled: boolean) => Promise<unknown>
  onTrigger: (id: string) => Promise<unknown>
  onEdit: (schedule: Schedule) => void
  onDelete: (id: string) => void
  onSelect: (schedule: Schedule) => void
  onCreateClick: () => void
}

export function ScheduleList({
  schedules,
  loading,
  onToggle,
  onTrigger,
  onEdit,
  onDelete,
  onSelect,
  onCreateClick,
}: Props) {
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null)

  const handleToggle = async (schedule: Schedule) => {
    setTogglingId(schedule.id)
    try {
      await onToggle(schedule.id, !schedule.enabled)
    } finally {
      setTogglingId(null)
    }
  }

  if (!loading && schedules.length === 0) {
    return <EmptyScheduleList onCreateClick={onCreateClick} />
  }

  return (
    <>
    <TooltipProvider>
      <Table aria-label="Schedule list">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead>Cron</TableHead>
            <TableHead>Next Run</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[100px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {schedules.map((schedule) => (
            <TableRow key={schedule.id} className="cursor-pointer" onClick={() => onSelect(schedule)}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  {schedule.name}
                  {!schedule.workflow_exists && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span role="img" aria-label={`Workflow not found for ${schedule.name}`}>
                          <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Workflow not found</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {schedule.workflow_ref}
              </TableCell>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {schedule.cron_expression}
                    </code>
                  </TooltipTrigger>
                  <TooltipContent>{schedule.cron_description ?? schedule.cron_expression}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {schedule.next_trigger_at
                  ? new Date(schedule.next_trigger_at).toLocaleString()
                  : "-"}
              </TableCell>
              <TableCell>
                <Badge variant={schedule.enabled ? "default" : "secondary"}>
                  {schedule.enabled ? "Active" : "Disabled"}
                </Badge>
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-1">
                  <Switch
                    checked={schedule.enabled}
                    onCheckedChange={() => handleToggle(schedule)}
                    disabled={togglingId === schedule.id}
                    aria-label={schedule.enabled ? "Disable" : "Enable"}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${schedule.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onTrigger(schedule.id)}>
                        <Play className="mr-2 h-3.5 w-3.5" />
                        Trigger Now
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onEdit(schedule)}>
                        <Edit className="mr-2 h-3.5 w-3.5" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setPendingDelete(schedule)}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Schedule</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{pendingDelete?.name}&rdquo;?
              This action can be undone from the database, but associated execution
              records will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete.id)
                  setPendingDelete(null)
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
