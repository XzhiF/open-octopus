"use client"

import { useEffect, useRef } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface CompositeEvent {
  /** The run this event belongs to — the task's own execution id (or the task id for
   *  a task_status row). 票03: this used to be a schedule id off the envelope. */
  run_id: string
  status: string
  /** Human label for the run (parent / child subunit name). */
  label: string
  /** Why a red run is red, one line — the `task_execution.reason` the server puts on
   *  the failure/reap paths only (票05). The panel never sees it on a green row: the
   *  producer gates on the run status, matching `runErrorOf` elsewhere. */
  reason?: string
  /** ISO timestamp of when the event was received by the client. */
  at: string
}

export interface CompositeEventsPanelProps {
  events: CompositeEvent[]
}

const STATUS_TONE: Record<string, string> = {
  // executions 词表 (票03: 任务运行行)
  pending: "text-pop-amber",
  running: "text-pop-cyan",
  completed: "text-pop-green",
  completed_with_failures: "text-pop-amber",
  cancelled: "text-pop-dim",
  rejected: "text-pop-dim",
  failed: "text-pop-red",
  aborted: "text-pop-dim",
  // 旧 schedule 词表
  queued: "text-pop-cyan",
  claimed: "text-pop-amber",
  done: "text-pop-green",
}

const STATUS_LABEL: Record<string, string> = {
  pending: "已排队", running: "执行中", completed: "成功",
  completed_with_failures: "完成(有失败)", cancelled: "已取消", rejected: "已驳回",
  failed: "失败", aborted: "已中止", skipped: "已跳过",
  paused: "已暂停", pending_approval: "待审批", pending_resume: "待续跑",
  queued: "待执行", claimed: "已认领", done: "完成",
  draft: "草稿", rollback: "回滚",
}

/** Right-side real-time SSE events panel. Renders a rolling log of the task's own
 *  `task_execution` events (each run: armed/launched/terminal) + its `task_status`
 *  rows, received since the modal opened. */
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
        <p className="text-[10px] text-muted-foreground">SSE task_execution · 本任务各运行</p>
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
                key={`${e.run_id}-${i}`}
                className="rounded border border-border bg-card/50 px-2 py-1.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{e.label}</span>
                  <span className={cn("font-medium shrink-0", STATUS_TONE[e.status] ?? "")}>
                    {STATUS_LABEL[e.status] ?? e.status}
                  </span>
                </div>
                {e.reason && (
                  <div className="text-[10px] text-pop-red mt-0.5 break-words" data-event-reason={e.run_id}>
                    {e.reason}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(e.at).toLocaleTimeString()}
                  <span className="ml-1.5 font-mono opacity-60">{e.run_id.slice(0, 8)}</span>
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
