// packages/web-app/components/tasks/trigger-dialog.tsx
//
// v39 人工触发对话框 — 入队(ready)不再自动执行；由用户在此显式触发：
//   · 立即触发 — trigger without `at` (server: scheduled_at = now, next wake)
//   · 定时触发 — one-shot future absolute time (datetime-local → ISO8601)
// 同任务互斥：一个任务同时只有一个实例——queued/running 状态下再次触发被服务端
// 409 拒绝；到点后的定时触发由 poller 领取（受全局并发上限 ≤3 约束）。

"use client"

import { useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Zap, Clock, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { Task } from "@octopus/shared"
import { triggerTask, cancelTaskTrigger } from "@/lib/tasks-api"

export interface TriggerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task | null
  /** Called after a successful trigger so the parent can refresh the board. */
  onTriggered?: () => void
}

export function TriggerDialog({ open, onOpenChange, task, onTriggered }: TriggerDialogProps) {
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState("")

  const doTrigger = async (immediate: boolean) => {
    if (!task) return
    let iso: string | undefined
    if (!immediate) {
      if (!at) {
        toast.error("请选择触发时间")
        return
      }
      const d = new Date(at)
      if (Number.isNaN(d.getTime())) {
        toast.error("时间格式无效")
        return
      }
      if (d.getTime() <= Date.now()) {
        toast.error("请选择未来的时间")
        return
      }
      iso = d.toISOString()
    }
    setBusy(true)
    try {
      await triggerTask(task.id, iso)
      toast.success(iso ? `已定时：${d0(iso)} 触发` : "已触发，任务即将开始执行")
      onOpenChange(false)
      setAt("")
      onTriggered?.()
    } catch (err) {
      // Conflict / not-ready rejections — the server's messages are already
      // user-facing Chinese ("任务已触发…"/"任务正在执行中"/"只有已入队…").
      toast.error(err instanceof Error ? err.message : "触发失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="size-4 text-primary" />
            触发任务
          </DialogTitle>
          <DialogDescription>
            {task?.name ?? ""} — 入队后需人工触发才会执行。定时触发为单次
            （到点跑一次，不再重复）；同一任务同时只能运行一个实例，排队/执行中重复触发会被拒绝。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="size-3.5" /> 定时触发时间（可选）
            </span>
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              disabled={busy}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void doTrigger(true)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
              立即触发
            </Button>
            <Button size="sm" disabled={busy || !at} onClick={() => void doTrigger(false)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Clock className="size-4" />}
              定时触发
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function d0(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

// ── Inline trigger/cancel actions (shared by SimpleExecutionMode + CompositeMode) ──

/** Renders per task state (v39):
 *  · ready                → 「触发」 button (opens TriggerDialog)
 *  · running + queued+future → 定时待触发提示 + 「取消触发」
 *  · running + queued+past  → 即将开始提示（不再显示取消——领取竞态由服务端守卫）
 *  · otherwise             → null */
export function TriggerActions({ task, onMutated }: { task: Task; onMutated: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const armed =
    task.status === "running" && task.schedule_status === "queued" && !!task.scheduled_at
  const future = armed && new Date(task.scheduled_at!).getTime() > Date.now()

  if (task.status === "ready") {
    return (
      <>
        <Button size="sm" onClick={() => setDialogOpen(true)} data-task-trigger>
          <Zap className="size-4" />
          触发
        </Button>
        <TriggerDialog open={dialogOpen} onOpenChange={setDialogOpen} task={task} onTriggered={onMutated} />
      </>
    )
  }

  if (armed) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-amber-600 dark:text-amber-400">
          {future
            ? `已定时 · ${new Date(task.scheduled_at!).toLocaleString()} 触发`
            : "已到点，即将执行"}
        </span>
        {future && (
          <Button
            variant="outline"
            size="sm"
            disabled={cancelling}
            data-task-trigger-cancel
            onClick={async () => {
              setCancelling(true)
              try {
                await cancelTaskTrigger(task.id)
                toast.success("已取消定时触发")
                onMutated()
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "取消失败")
              } finally {
                setCancelling(false)
              }
            }}
          >
            取消触发
          </Button>
        )}
      </div>
    )
  }

  return null
}
