"use client"

import { useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, Check, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import type { AgentEvent } from "@/lib/types"
import { EventIcon, EventLabel, ExpandableRow } from "./execution-log-viewer"

interface IterationGroupProps {
  loopId: string
  iteration: number
  events: AgentEvent[]
  isLatest: boolean
  totalIterations: number
}

export function IterationGroup({
  loopId,
  iteration,
  events,
  isLatest,
  totalIterations,
}: IterationGroupProps) {
  // Default: expand latest only when >3 iterations
  const [open, setOpen] = useState(totalIterations <= 3 || isLatest)

  const completedCount = events.filter(e => e.status === "completed").length
  const failedCount = events.filter(e => e.status === "failed").length
  const totalDurationMs = events.reduce((sum, e) => sum + (e.durationMs ?? 0), 0)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 w-full px-2 py-1 text-xs font-medium",
            "bg-muted/20 hover:bg-muted/40 rounded transition-colors cursor-pointer",
          )}
        >
          {open
            ? <ChevronDown className="h-3 w-3 shrink-0" />
            : <ChevronRight className="h-3 w-3 shrink-0" />
          }
          <span className="text-muted-foreground">
            iter-{iteration}:
          </span>
          <span className="truncate">
            {events.slice(0, 3).map((e, i) => (
              <span key={i} className="inline-flex items-center gap-0.5 mr-1.5">
                {e.nodeId}
                {e.status === "completed"
                  ? <Check className="h-2.5 w-2.5 text-emerald-400" />
                  : e.status === "failed"
                    ? <X className="h-2.5 w-2.5 text-red-400" />
                    : null
                }
              </span>
            ))}
          </span>
          <span className="text-muted-foreground/50 ml-auto text-[10px] shrink-0">
            {totalDurationMs > 0 && `耗时 ${formatDuration(totalDurationMs / 1000)}`}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border/30 pl-2">
          {events.map((entry, i) => (
            <ExpandableRow key={i} entry={entry as any} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
