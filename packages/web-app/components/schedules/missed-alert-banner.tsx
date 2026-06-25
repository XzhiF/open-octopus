"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"
import type { Schedule } from "@/lib/types"
import { dismissScheduleAlert } from "@/lib/schedule-api"

interface Props {
  schedule: Schedule
  wsId: string
  onDismissed: () => void
}

export function MissedAlertBanner({ schedule, wsId, onDismissed }: Props) {
  if (schedule.missed_alert_dismissed_at) return null

  const handleDismiss = async () => {
    try {
      await dismissScheduleAlert(wsId, schedule.id)
      onDismissed()
    } catch {
      // Silently fail
    }
  }

  return (
    <Alert variant="default" className="border-yellow-300 bg-yellow-50 dark:bg-yellow-950/30 dark:border-yellow-800">
      <AlertTriangle className="h-4 w-4 text-yellow-600" />
      <AlertTitle className="text-yellow-800 dark:text-yellow-200">Missed Execution</AlertTitle>
      <AlertDescription className="flex items-center justify-between text-yellow-700 dark:text-yellow-300">
        <span>
          Schedule &ldquo;{schedule.name}&rdquo; missed one or more scheduled triggers.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDismiss}
          className="ml-4 h-7 border-yellow-400 text-yellow-800 hover:bg-yellow-100"
        >
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  )
}
