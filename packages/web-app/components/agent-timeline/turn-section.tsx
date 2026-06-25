"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { TurnGroup, AgentTraceEvent } from "@/lib/types"
import { ChevronRight, Brain, Wrench, MessageSquare, AlertTriangle, Clock } from "lucide-react"
import { ThinkingBlock } from "./thinking-block"
import { ToolCallRow } from "./tool-call-row"
import { TextOutputBlock } from "./text-output-block"

const AGENT_EVENT_COLORS: Record<string, { text: string; bg: string }> = {
  thinking: { text: "text-violet-500", bg: "bg-violet-500/5" },
  tool: { text: "text-amber-500", bg: "bg-amber-500/5" },
  text: { text: "text-blue-500", bg: "bg-blue-500/5" },
  error: { text: "text-red-500", bg: "bg-red-500/5" },
  status: { text: "text-gray-500", bg: "bg-gray-500/5" },
}

function getTurnDuration(turn: TurnGroup): number {
  if (turn.events.length === 0) return 0
  const first = turn.events[0].timestamp
  const last = turn.events[turn.events.length - 1].timestamp
  return last - first
}

function getTurnSummary(turn: TurnGroup): string {
  const parts: string[] = []
  const thinkingEvents = turn.events.filter(e => e.event_type.startsWith("thinking"))
  const toolEvents = turn.events.filter(e => e.event_type.startsWith("tool"))
  const textEvents = turn.events.filter(e => e.event_type.startsWith("text"))

  if (thinkingEvents.length > 0) parts.push("thinking")
  if (toolEvents.length > 0) {
    const toolNames = [...new Set(toolEvents.map(e => e.tool_name).filter(Boolean))]
    parts.push(`${toolNames.length} tool${toolNames.length > 1 ? "s" : ""}`)
  }
  if (textEvents.length > 0) parts.push("output")
  return parts.join(" · ") || "no events"
}

function groupEventsByType(events: AgentTraceEvent[]): Array<{ type: string; events: AgentTraceEvent[] }> {
  const groups: Array<{ type: string; events: AgentTraceEvent[] }> = []
  let currentType = ""
  let currentEvents: AgentTraceEvent[] = []

  for (const event of events) {
    const type = event.event_type.startsWith("thinking") ? "thinking"
      : event.event_type.startsWith("tool") ? "tool"
      : event.event_type.startsWith("text") ? "text"
      : event.event_type.startsWith("error") ? "error"
      : "status"

    if (type !== currentType) {
      if (currentEvents.length > 0) {
        groups.push({ type: currentType, events: currentEvents })
      }
      currentType = type
      currentEvents = [event]
    } else {
      currentEvents.push(event)
    }
  }
  if (currentEvents.length > 0) {
    groups.push({ type: currentType, events: currentEvents })
  }

  return groups
}

interface TurnSectionProps {
  turn: TurnGroup
  isExpanded: boolean
  isLive: boolean
  onToggle: () => void
}

export function TurnSection({ turn, isExpanded, isLive, onToggle }: TurnSectionProps) {
  const duration = getTurnDuration(turn)
  const summary = getTurnSummary(turn)
  const eventGroups = isExpanded ? groupEventsByType(turn.events) : []

  return (
    <div className={cn(
      "rounded-lg border transition-colors",
      isLive && "border-violet-300 dark:border-violet-700",
      !isExpanded && "hover:bg-muted/50 cursor-pointer",
    )}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        <span className="font-medium tabular-nums">T{turn.turn_index + 1}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{summary}</span>
        <div className="ml-auto flex items-center gap-2">
          {isLive && (
            <span className="flex items-center gap-1 text-xs text-violet-500">
              <Clock className="h-3 w-3 animate-pulse" />
              streaming
            </span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {duration > 0 ? `${(duration / 1000).toFixed(1)}s` : ""}
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {eventGroups.map((group, gi) => {
            if (group.type === "thinking") {
              const content = group.events.map(e => e.content ?? "").join("")
              return (
                <ThinkingBlock
                  key={gi}
                  content={content}
                  isExpanded={true}
                  isStreaming={isLive}
                />
              )
            }
            if (group.type === "tool") {
              return group.events
                .filter(e => e.event_type === "tool_start" || e.event_type === "tool_result")
                .reduce<Array<{ name: string; input?: string; result?: string; duration?: number; isError: boolean }>>((acc, e) => {
                  if (e.event_type === "tool_start") {
                    acc.push({ name: e.tool_name ?? "unknown", input: e.tool_input, isError: !!e.tool_is_error })
                  } else if (acc.length > 0) {
                    const last = acc[acc.length - 1]
                    last.result = e.tool_result
                    last.isError = !!e.tool_is_error
                    last.duration = e.tool_duration_ms
                  }
                  return acc
                }, [])
                .map((tool, ti) => (
                  <ToolCallRow
                    key={ti}
                    toolName={tool.name}
                    durationMs={tool.duration ?? 0}
                    isError={tool.isError}
                    inputPreview={tool.input ?? ""}
                    resultPreview={tool.result ?? ""}
                  />
                ))
            }
            if (group.type === "text") {
              const content = group.events.map(e => e.content ?? "").join("")
              return (
                <TextOutputBlock key={gi} content={content} />
              )
            }
            if (group.type === "error") {
              return (
                <div key={gi} className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{group.events.map(e => e.error_message ?? e.content ?? "").join(" ")}</span>
                </div>
              )
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}
