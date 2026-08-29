// packages/web-app/components/tasks/authoring/workflow-viewer-dialog.tsx
//
// Full-content viewer for the workflow a task is bound to (workflow_ref).
// Opens when the user clicks the bound-workflow badge in WorkflowBox — the
// workflow-binding counterpart of ArtifactViewerDialog (产物「点击查看完整内容」):
// same dialog shell, same loading/error/content state machine, same monospace
// raw-text render (no syntax highlighting — YAML verbatim, like artifacts).
//
// Data: GET /api/tasks/:id/workflow-ref → { ref, content, source } — the
// server resolves installed-builtin first, then task home workflows/.
// Degraded states mirror ArtifactViewerDialog's discipline (never a white
// screen): 400 = bound but no longer resolvable (workflow deleted/uninstalled),
// 404 = task gone, null content = unbound (race: binding cleared while open).

"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { FileCode2, ShieldAlert, FileQuestion } from "lucide-react"
import {
  getWorkflowRefView,
  WorkflowRefViewError,
  type WorkflowRefView,
} from "@/lib/tasks-api"

export interface WorkflowViewerDialogProps {
  taskId: string | null
  /** The workflow_ref currently bound — shown as the dialog title. */
  workflowRef: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Loaded {
  kind: "loaded"
  view: WorkflowRefView
}
interface Errored {
  kind: "error"
  status: number
  message: string
}
interface Loading {
  kind: "loading"
}
type State = Loading | Loaded | Errored

const SOURCE_LABELS: Record<string, string> = {
  builtin: "内置工作流",
  "task-home": "任务自建工作流",
}

export function WorkflowViewerDialog({ taskId, workflowRef, open, onOpenChange }: WorkflowViewerDialogProps) {
  const [state, setState] = useState<State>({ kind: "loading" })

  // Fetch on every open — the binding (or the underlying YAML) may have
  // changed between views; re-fetch keeps the dialog live, same as artifacts.
  useEffect(() => {
    if (!open || !taskId) return
    let cancelled = false
    setState({ kind: "loading" })
    getWorkflowRefView(taskId)
      .then((view) => {
        if (!cancelled) setState({ kind: "loaded", view })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof WorkflowRefViewError) {
          setState({ kind: "error", status: err.status, message: err.message })
        } else {
          setState({
            kind: "error",
            status: 0,
            message: err instanceof Error ? err.message : "加载失败",
          })
        }
      })
    return () => { cancelled = true }
  }, [open, taskId])

  // Line/char stats for the footer (only when YAML is actually loaded).
  const stats =
    state.kind === "loaded" && state.view.content
      ? { lines: state.view.content.split("\n").length, chars: state.view.content.length }
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[720px] h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col"
        showCloseButton
        data-workflow-viewer-dialog
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0 space-y-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            <FileCode2 className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{workflowRef ?? (state.kind === "loaded" ? state.view.ref : "")}</span>
            {state.kind === "loaded" && state.view.source && (
              <span className="text-[10px] font-normal text-muted-foreground shrink-0">
                {SOURCE_LABELS[state.view.source] ?? state.view.source}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-[10px] truncate">
            {taskId ? `GET /api/tasks/${taskId}/workflow-ref` : ""}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0" data-workflow-content-scroll>
          {state.kind === "loading" ? (
            <div className="flex items-center justify-center p-8 text-xs text-muted-foreground gap-2">
              <Spinner className="size-4" /> 读取工作流内容…
            </div>
          ) : state.kind === "error" ? (
            <div className="p-6 space-y-2 text-xs" data-workflow-degraded>
              {state.status === 400 ? (
                <div className="flex items-start gap-2 text-amber-600">
                  <ShieldAlert className="size-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">绑定的工作流已不存在</div>
                    <div className="text-muted-foreground mt-0.5">
                      该 ref 曾经有效，但已不在内置清单或任务工作目录中——可能工作流被卸载/删除。入队会被门禁拦截，请点击「更换工作流」重新绑定。
                    </div>
                  </div>
                </div>
              ) : state.status === 404 ? (
                <div className="flex items-start gap-2 text-amber-600">
                  <FileQuestion className="size-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">任务不存在</div>
                    <div className="text-muted-foreground mt-0.5">任务可能已被删除。</div>
                  </div>
                </div>
              ) : (
                <div className="text-red-600">{state.message || "加载工作流内容失败"}</div>
              )}
            </div>
          ) : state.kind === "loaded" && state.view.content ? (
            <pre className="p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono break-words" data-workflow-content>
              {state.view.content}
            </pre>
          ) : (
            <div className="p-6 text-xs text-muted-foreground italic" data-workflow-degraded>
              任务尚未绑定工作流。
            </div>
          )}
        </ScrollArea>

        <div className="px-4 py-2 border-t text-[10px] text-muted-foreground shrink-0 flex items-center justify-between gap-2">
          <span>入队时按此定义 + 输入参数物化执行</span>
          {stats && (
            <span className="font-mono shrink-0 tabular-nums" data-workflow-stats>
              {stats.lines} 行 · {stats.chars} 字
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
