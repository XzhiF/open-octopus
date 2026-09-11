// packages/web-app/components/tasks/trigger-dialog.tsx
//
// v39 人工触发对话框 — 入队(ready)不再自动执行；由用户在此显式触发：
//   · 立即触发 — trigger without `at` (server arms + launches inside the cap at once)
//   · 定时触发 — one-shot future absolute time (datetime-local → ISO8601)
// 票03 (ADR-0021): 定时 = `tasks.trigger_mode='once' + next_fire_at`（任务自己的
// 到期游标，由内置 task-lifecycle job 到点起），不再写私有 schedule 信封。
// 同任务互斥：一个任务同时只有一个实例——排队/执行中再次触发被服务端 409 拒绝
// （到点后的领取受全局并发上限约束，pending 行 = 已排队等位）。

"use client"

import { useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Zap, Clock, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { Task } from "@octopus/shared"
import { triggerTask, cancelTaskTrigger, type TaskView } from "@/lib/tasks-api"

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

/** Renders per task state (v39, 票03 语义):
 *  · ready + 无游标        → 「触发」 button (opens TriggerDialog)
 *  · once 游标在未来        → 已定时提示 + 「取消触发」(status 仍是 ready —— armOnce
 *                            只写 next_fire_at，不建实例)
 *  · 实例 pending（并发闸后等位）→ 排队提示（不给取消：与旧的「已到点」窗口同义，
 *                            领取竞态由服务端守卫）
 *  · otherwise             → null */
export function TriggerActions({ task, onMutated }: { task: TaskView; onMutated: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // 票03: 「已排队」的两个真相都在任务自己身上 —— next_fire_at 是唯一的到期游标，
  // execution.status='pending' 表示实例已武装、在共享并发闸后等位。
  const dueAt = task.next_fire_at
  const armedFuture = !!dueAt && new Date(dueAt).getTime() > Date.now()
  const waitingForSlot = task.execution?.status === "pending"

  if (armedFuture || waitingForSlot) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-pop-amber">
          {armedFuture
            ? `已定时 · ${new Date(dueAt!).toLocaleString()} 触发`
            : "已到点，即将执行"}
        </span>
        {armedFuture && (
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

  return null
}
