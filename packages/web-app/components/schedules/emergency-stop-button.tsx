"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { emergencyStopSchedules } from "@/lib/schedule-api"
import { AlertTriangle, Loader2 } from "lucide-react"

interface Props {
  wsId: string
  onStopped: () => void
}

export function EmergencyStopButton({ wsId, onStopped }: Props) {
  const [stopping, setStopping] = useState(false)

  const handleStop = async () => {
    setStopping(true)
    try {
      await emergencyStopSchedules(wsId)
      onStopped()
    } finally {
      setStopping(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
          Emergency Stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Emergency Stop All Schedules</AlertDialogTitle>
          <AlertDialogDescription>
            This will immediately disable all active schedules and cancel any running
            scheduled executions. This action cannot be undone — you will need to
            re-enable schedules individually afterward.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleStop}
            disabled={stopping}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {stopping && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Stop All Schedules
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
