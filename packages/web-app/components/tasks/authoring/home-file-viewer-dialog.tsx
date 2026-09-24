// packages/web-app/components/tasks/authoring/home-file-viewer-dialog.tsx
//
// 输出区目录树的文件查看弹窗（2026-09-24「任务 home 如实直扫」改版）：
// 读 GET /:id/home-content（home 下任意常规文件），mono 全文展示。
// 交互契约同 ArtifactViewerDialog：只读、无审批按钮（D11 —— 有意见走对话）；
// 403/404/413 在弹窗内降级显示，不白屏。

"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { FileText, ShieldAlert, FileQuestion } from "lucide-react"
import { getHomeContent, TaskApiError, MAX_HOME_FILE_READ_BYTES } from "@/lib/tasks-api"

export interface HomeFileViewerTarget {
  path: string
  bytes: number
}

export function HomeFileViewerDialog({ taskId, target, onOpenChange }: {
  taskId: string
  target: HomeFileViewerTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "text"; content: string } | { kind: "error"; status: number; message: string }
  >({ kind: "loading" })

  useEffect(() => {
    if (!target) return
    let cancelled = false
    setState({ kind: "loading" })
    getHomeContent(taskId, target.path)
      .then((r) => { if (!cancelled) setState({ kind: "text", content: r.content }) })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = err instanceof TaskApiError ? err.status : 500
        setState({ kind: "error", status, message: err instanceof Error ? err.message : String(err) })
      })
    return () => { cancelled = true }
  }, [taskId, target])

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px] sm:max-w-[720px] max-h-[80vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-4 py-3 border-b shrink-0 space-y-0">
          <DialogTitle className="text-sm flex items-center gap-2 font-mono">
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{target?.path}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px]">
            任务 home 直读 · {target && target.bytes > 0 ? `${target.bytes} B` : "磁盘"} · 上限 {Math.floor(MAX_HOME_FILE_READ_BYTES / 1024)} KB
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1 min-h-0 px-4 py-3">
          {state.kind === "loading" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6"><Spinner className="size-3.5" /> 读取中…</div>
          )}
          {state.kind === "text" && (
            <pre data-home-file-content className="whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed">{state.content || "（空文件）"}</pre>
          )}
          {state.kind === "error" && (
            <div className="flex items-start gap-2 text-xs py-6 text-muted-foreground">
              {state.status === 403
                ? <ShieldAlert className="size-4 mt-0.5 shrink-0 text-pop-amber" />
                : <FileQuestion className="size-4 mt-0.5 shrink-0 text-muted-foreground" />}
              <div>
                <div>{state.status === 403 ? "路径不在读取范围（越出任务 home）"
                  : state.status === 404 ? "文件已不在磁盘上（列表可能滞后，点 ↻ 重扫）"
                  : state.status === 413 ? `文件超过 ${Math.floor(MAX_HOME_FILE_READ_BYTES / 1024)}KB 读取上限`
                  : "读取失败"}</div>
                <div className="mt-1 font-mono text-[10px] opacity-70">{state.message}</div>
              </div>
            </div>
          )}
        </ScrollArea>
        <div className="shrink-0 border-t px-4 py-2 text-[10px] text-muted-foreground">
          有意见？关闭后在左侧对话里直接说，agent 会修改并更新此文件
        </div>
      </DialogContent>
    </Dialog>
  )
}
