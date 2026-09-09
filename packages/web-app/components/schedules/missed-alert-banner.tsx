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
    <Alert variant="default" className="border-pop-yellow/50 bg-pop-yellow-soft">
      <AlertTriangle className="h-4 w-4 text-pop-amber" />
      <AlertTitle className="text-pop-ink">Missed Execution</AlertTitle>
      <AlertDescription className="flex items-center justify-between text-pop-ink">
        <span>
          Schedule &ldquo;{schedule.name}&rdquo; missed one or more scheduled triggers.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDismiss}
          className="ml-4 h-7 border-pop-yellow/60 text-pop-ink hover:bg-pop-yellow-soft"
        >
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  )
}
