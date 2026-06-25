"use client"

import { useCronParse } from "@/hooks/use-cron-parse"
import { Loader2 } from "lucide-react"

interface Props {
  expression: string
  timezone: string
}

export function CronPreview({ expression, timezone }: Props) {
  const { result, loading } = useCronParse(expression, timezone)

  if (!expression.trim()) return null

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Parsing...
      </div>
    )
  }

  if (!result) return null

  if (!result.valid) {
    return (
      <p className="text-xs text-destructive">
        Invalid cron expression: {result.error ?? "unknown error"}
      </p>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md bg-muted/50 p-3">
      <p className="text-xs font-medium">{result.description}</p>
      {result.nextExecutions.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">Next executions:</p>
          {result.nextExecutions.slice(0, 5).map((time) => (
            <p key={time} className="text-xs text-muted-foreground/80">
              {new Date(time).toLocaleString()}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
