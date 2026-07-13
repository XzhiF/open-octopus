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
  nodeEventMap?: Map<string, AgentEvent[]>
  iterDurationMs?: number
}

export function IterationGroup({
  loopId,
  iteration,
  events,
  isLatest,
  totalIterations,
  nodeEventMap,
  iterDurationMs,
}: IterationGroupProps) {
  // Default: expand latest only when >3 iterations
  const [open, setOpen] = useState(totalIterations <= 3 || isLatest)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  const duration = iterDurationMs ?? events.reduce((sum, e) => sum + (e.durationMs ?? 0), 0)

  // Header preview: show node names with status indicators
  const headerPreview = events.slice(0, 3).map((e, i) => (
    <span key={i} className="inline-flex items-center gap-0.5 mr-1.5">
      {e.nodeId}
      {e.status === "completed"
        ? <Check className="h-2.5 w-2.5 text-emerald-400" />
        : e.status === "failed"
          ? <X className="h-2.5 w-2.5 text-red-400" />
          : null
      }
    </span>
  ))

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

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
            Iteration {iteration}:
          </span>
          <span className="truncate">{headerPreview}</span>
          <span className="text-muted-foreground/50 ml-auto text-[10px] shrink-0">
            {events.length} events{duration > 0 && ` · ${formatDuration(duration / 1000)}`}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 mt-0.5 space-y-1 border-l border-border/30 pl-2">
          {nodeEventMap && nodeEventMap.size > 0
            // Per-node sub-groups (new rendering)
            ? Array.from(nodeEventMap.entries()).map(([subNodeId, subEvents]) => {
                const subExpanded = expandedNodes.has(subNodeId)
                return (
                  <div key={subNodeId}>
                    <button
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground rounded cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); toggleNode(subNodeId) }}
                    >
                      {subExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                      <span>{subNodeId}</span>
                      <span className="text-muted-foreground/40">× {subEvents.length}</span>
                    </button>
                    {subExpanded && (
                      <div className="ml-3 mt-0.5 space-y-0.5">
                        {subEvents.map((entry, i) => (
                          <ExpandableRow key={`${subNodeId}-${i}`} entry={entry as any} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            // Fallback: flat event list (same as before)
            : events.map((entry, i) => (
                <ExpandableRow key={i} entry={entry as any} />
              ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
