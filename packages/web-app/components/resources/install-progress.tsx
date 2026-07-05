"use client"

import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"
import { Loader2, Check, X } from "lucide-react"
import type { InstallProgress } from "@/lib/types"

interface InstallProgressDisplayProps {
  progress: InstallProgress[]
  total: number
  className?: string
}

export function InstallProgressDisplay({ progress, total, className }: InstallProgressDisplayProps) {
  const completedSteps = progress.filter(p => p.status === "success" || p.status === "failed").length
  const progressValue = total > 0 ? (completedSteps / total) * 100 : 0

  return (
    <div className={cn("space-y-4", className)} aria-live="polite" role="status">
      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">安装进度</span>
          <span className="text-muted-foreground">{completedSteps}/{total}</span>
        </div>
        <Progress value={progressValue} className="h-2" />
      </div>

      {/* Step list */}
      <ul className="space-y-2">
        {progress.map((step, index) => (
          <li
            key={`${step.name}-${index}`}
            className="flex items-center gap-2 text-sm"
          >
            {step.status === "success" ? (
              <Check className="size-4 text-resource-installed shrink-0" />
            ) : step.status === "failed" ? (
              <X className="size-4 text-resource-missing shrink-0" />
            ) : (
              <Loader2 className="size-4 text-resource-installing animate-spin shrink-0" />
            )}
            <span className={cn(
              "font-medium",
              step.status === "failed" && "text-destructive"
            )}>
              {step.name}
            </span>
            {step.status === "success" && (
              <span className="text-xs text-muted-foreground">完成</span>
            )}
            {step.status === "failed" && (
              <span className="text-xs text-destructive">失败</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
