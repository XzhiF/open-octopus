// packages/web-app/components/tasks/authoring/artifact-viewer-dialog.tsx
//
// The v3 artifact full-content viewer dialog (ticket 10, US7/AC1/AC2/D11).
// Opens when the user clicks an artifact row in the OutputViewer. Fetches the
// live disk content via GET /api/tasks/:id/artifacts/content?path= and renders
// it monospace. Interaction reference: prototype VariantL artifact dialog
// (app/tasks/prototype/page.tsx:3428) — code rewritten, not copied.
//
// AC1: monospace full-content render; bottom hint "有意见在对话里说" — NO
// approval/reject buttons (D11: opinions go through the chat, not a review UI).
// AC2: 403 (escape/unregistered) + 404 (whitelisted but missing on disk) → a
// degraded state inside the dialog (never a white screen). ArtifactContentError
// carries the status so the hint matches the failure mode.

"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { FileText, ShieldAlert, FileQuestion } from "lucide-react"
import type { ArtifactIndexEntry } from "@octopus/shared"
import {
  getArtifactContent,
  ArtifactContentError,
} from "@/lib/tasks-api"

export interface ArtifactViewerDialogProps {
  taskId: string
  /** The entry being viewed; null/undefined → dialog closed. */
  entry: ArtifactIndexEntry | null
  onOpenChange: (open: boolean) => void
}

interface Loaded {
  kind: "loaded"
  content: string
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

export function ArtifactViewerDialog({ taskId, entry, onOpenChange }: ArtifactViewerDialogProps) {
  const open = !!entry
  const [state, setState] = useState<State>({ kind: "loading" })

  // Fetch content when a new entry opens. Reset on close so a reopen re-fetches
  // live disk content (the agent may have rewritten the artifact between views).
  useEffect(() => {
    if (!entry) return
    let cancelled = false
    setState({ kind: "loading" })
    getArtifactContent(taskId, entry.path)
      .then((res) => {
        if (!cancelled) setState({ kind: "loaded", content: res.content })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ArtifactContentError) {
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
  }, [taskId, entry])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[720px] max-h-[85vh] p-0 gap-0 flex flex-col"
        showCloseButton
        data-artifact-viewer-dialog
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0 space-y-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            <FileText className="size-3.5" />
            <span className="truncate">{entry?.title || entry?.path}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] truncate">
            {entry ? `${entry.path} · by ${entry.by}${entry.external ? " · external" : ""}` : ""}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0" data-artifact-content-scroll>
          {state.kind === "loading" ? (
            <div className="flex items-center justify-center p-8 text-xs text-muted-foreground gap-2">
              <Spinner className="size-4" /> 读取产物内容…
            </div>
          ) : state.kind === "error" ? (
            <div className="p-6 space-y-2 text-xs" data-artifact-degraded>
              {state.status === 403 ? (
                <div className="flex items-start gap-2 text-amber-600">
                  <ShieldAlert className="size-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">无权访问该路径</div>
                    <div className="text-muted-foreground mt-0.5">
                      路径越权或未在 artifacts.json 登记（external 产物需先登记才能查看）。
                    </div>
                  </div>
                </div>
              ) : state.status === 404 ? (
                <div className="flex items-start gap-2 text-amber-600">
                  <FileQuestion className="size-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">磁盘上未找到该文件</div>
                    <div className="text-muted-foreground mt-0.5">
                      产物已登记但文件缺失——可能 agent 尚未写入或被外部删除。
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-red-600">{state.message || "加载产物内容失败"}</div>
              )}
            </div>
          ) : (
            <pre className="p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono break-words" data-artifact-content>
              {state.content}
            </pre>
          )}
        </ScrollArea>

        <div className="px-4 py-2 border-t text-[10px] text-muted-foreground shrink-0">
          有意见？关闭后在左侧对话里直接说，agent 会修改并更新此产物
        </div>
      </DialogContent>
    </Dialog>
  )
}
