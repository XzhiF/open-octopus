"use client"

import { useEffect, useRef } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface CompositeEvent {
  schedule_id: string
  status: string
  /** Human label for the schedule (parent / child subunit name). */
  label: string
  /** ISO timestamp of when the event was received by the client. */
  at: string
}

export interface CompositeEventsPanelProps {
  events: CompositeEvent[]
}

const STATUS_TONE: Record<string, string> = {
  queued: "text-blue-500",
  claimed: "text-amber-600",
  running: "text-blue-500",
  done: "text-emerald-600",
  failed: "text-red-500",
  aborted: "text-zinc-500",
}

const STATUS_LABEL: Record<string, string> = {
  queued: "待执行", claimed: "已认领", running: "执行中",
  done: "完成", failed: "失败", aborted: "已中止",
  draft: "草稿", rollback: "回滚",
}

/** Right-side real-time SSE events panel. Renders a rolling log of schedule_status
 *  events (parent + each child) received since the modal opened. */
export function CompositeEventsPanel({ events }: CompositeEventsPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the latest event when new ones arrive. Guarded for jsdom /
  // environments where scrollIntoView is not implemented.
  useEffect(() => {
    const el = bottomRef.current
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "end" })
    }
  }, [events.length])

  return (
    <div
      className="flex flex-col h-full min-h-0"
      data-testid="composite-events-panel"
    >
      <div className="shrink-0 px-3 py-2 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground">实时事件</h3>
        <p className="text-[10px] text-muted-foreground">SSE schedule_status · 父 + 各子</p>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1">
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              等待事件…
            </p>
          ) : (
            events.map((e, i) => (
              <div
                key={`${e.schedule_id}-${i}`}
                className="rounded border border-border bg-card/50 px-2 py-1.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{e.label}</span>
                  <span className={cn("font-medium shrink-0", STATUS_TONE[e.status] ?? "")}>
                    {STATUS_LABEL[e.status] ?? e.status}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(e.at).toLocaleTimeString()}
                  <span className="ml-1.5 font-mono opacity-60">{e.schedule_id.slice(0, 8)}</span>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  )
}
