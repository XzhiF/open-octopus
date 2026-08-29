// packages/web-app/components/tasks/authoring/workflow-log-dialog.tsx
//
// The v3 assist-workflow process-log dialog (ticket 10, US10/AC3). Opens when
// the user clicks a run row in the OutputViewer. Renders the run's logs line-
// by-line: timestamp + icon + text (the {t, icon, text} shape from
// assistWorkflowLogSchema, mapped server-side from the engine's JSONL entries).
// Interaction reference: prototype VariantL log dialog
// (app/tasks/prototype/page.tsx:3444) — code rewritten, not copied.

"use client"

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import type { AssistWorkflowRun } from "@octopus/shared"

export interface WorkflowLogDialogProps {
  /** The run whose logs to show; null → dialog closed. */
  run: AssistWorkflowRun | null
  onOpenChange: (open: boolean) => void
}

/** Translate the execution-lifecycle status vocabulary (owned by the server)
 *  into a {label, tone} badge. The shared schema carries status as a permissive
 *  string; the mapping here is best-effort + falls back to a neutral badge. */
function statusBadge(status: string): { label: string; className: string } {
  const cls = "text-[9px] "
  switch (status) {
    case "running":
      return { label: "运行中", className: cls + "bg-purple-500/15 text-purple-600 animate-pulse" }
    case "done":
    case "completed":
      return { label: "完成", className: cls + "bg-emerald-500/15 text-emerald-600" }
    case "failed":
    case "error":
      return { label: "失败", className: cls + "bg-red-500/15 text-red-600" }
    case "aborted":
      return { label: "中止", className: cls + "bg-zinc-500/15 text-zinc-600" }
    case "pending":
    case "queued":
      return { label: "排队", className: cls + "bg-amber-500/15 text-amber-600" }
    default:
      return { label: status || "未知", className: cls + "bg-muted text-muted-foreground" }
  }
}

export function WorkflowLogDialog({ run, onOpenChange }: WorkflowLogDialogProps) {
  const open = !!run
  const badge = run ? statusBadge(run.status) : { label: "", className: "" }
  const logCount = run?.logs.length ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[640px] h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col"
        showCloseButton
        data-workflow-log-dialog
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0 space-y-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            🧠 {run?.template ?? "assist-workflow"}
            <Badge className={badge.className}>{badge.label}</Badge>
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            workflow run · {logCount} 条日志
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          {logCount === 0 ? (
            <div className="p-6 text-xs text-muted-foreground" data-workflow-empty-logs>
              暂无过程日志——run 尚未产出日志条目（可能仍在启动或因无 provider 立即失败）。
            </div>
          ) : (
            <div className="p-4 space-y-1 font-mono text-[11px]" data-workflow-logs>
              {run!.logs.map((l, i) => (
                <div key={i} className="flex gap-2 leading-relaxed">
                  <span className="text-muted-foreground/60 shrink-0 select-none">[{l.t}]</span>
                  <span className="shrink-0 select-none" aria-hidden>{l.icon}</span>
                  <span className="break-words">{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
