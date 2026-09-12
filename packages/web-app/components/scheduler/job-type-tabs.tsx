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
    <div className="flex gap-1.5 rounded-xl border-2 border-pop-bd bg-pop-idle p-1 shadow-pop-sm">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("workflow")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-lg border-[1.5px] px-3 py-2 text-sm transition-colors",
          value === "workflow"
            ? "bg-pop-purple text-white font-black border-pop-bd shadow-pop-sm"
            : "text-pop-dim font-bold border-transparent hover:text-pop-ink hover:bg-pop-purple-soft",
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
          "flex flex-1 items-center justify-center gap-2 rounded-lg border-[1.5px] px-3 py-2 text-sm transition-colors",
          value === "agent"
            ? "bg-pop-pink text-white font-black border-pop-bd shadow-pop-sm"
            : "text-pop-dim font-bold border-transparent hover:text-pop-ink hover:bg-pop-pink-soft",
          disabled && "cursor-not-allowed opacity-50"
        )}
      >
        <Bot className="size-4" />
        Agent
      </button>
    </div>
  )
}
