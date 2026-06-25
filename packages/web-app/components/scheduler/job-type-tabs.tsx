"use client"

import { cn } from "@/lib/utils"
import { GitBranch, Bot } from "lucide-react"
import type { JobType } from "@/lib/scheduler-api"

interface JobTypeTabsProps {
  value: JobType
  onChange: (type: JobType) => void
  disabled?: boolean
}

export function JobTypeTabs({ value, onChange, disabled }: JobTypeTabsProps) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("workflow")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          value === "workflow"
            ? "bg-background text-scheduler-primary shadow-sm"
            : "text-muted-foreground hover:text-foreground",
          disabled && "cursor-not-allowed opacity-50"
        )}
      >
        <GitBranch className="size-4" />
        Workflow
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("agent")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          value === "agent"
            ? "bg-background text-scheduler-accent shadow-sm"
            : "text-muted-foreground hover:text-foreground",
          disabled && "cursor-not-allowed opacity-50"
        )}
      >
        <Bot className="size-4" />
        Agent
      </button>
    </div>
  )
}
