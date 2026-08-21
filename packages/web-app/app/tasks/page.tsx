"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { RefreshCw, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import type { Task } from "@octopus/shared"
import { listTasks, deleteTask } from "@/lib/tasks-api"
import { toast } from "sonner"
import { groupTasksByStatus, TASK_COLUMNS } from "@/lib/task-board"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { TaskModal } from "@/components/tasks/task-modal"
import { TASK_STATUS_EVENT, SPEC_FIELD_UPDATE_EVENT } from "@octopus/shared"

const REFRESH_INTERVAL_MS = 10_000

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // null task = new-task authoring ([+新建]); a Task = card click.
  const [modalTask, setModalTask] = useState<Task | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const fetchTasks = useCallback(async () => {
    try {
      // GET /api/tasks — first-class tasks domain (SG14: read Task, not
      // SchedulerJob). No trigger_source filter (that was the old schedules
      // hack); the tasks table owns the lifecycle directly.
      const data = await listTasks()
      setTasks(data.items)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tasks")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTasks()
    const id = setInterval(fetchTasks, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchTasks])

  // Real-time push: task_status SSE fires on every lifecycle transition
  // (ScheduleStatusListener, SG2 — queued/claimed→running, done→done,
  // failed→failed, aborted→aborted) + draft→ready via /ready. Refresh the
  // kanban so cards move columns instantly.
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      TASK_STATUS_EVENT,
      () => {
        void fetchTasks()
      },
    )
    return () => unsub()
  }, [fetchTasks])

  // spec_field_update: refetch immediately when ANY task's spec changes
  // (agent binds goal/ac/skills/etc. via the spec-field tool). This makes
  // the SpecPanel's version-based re-seed fire without waiting for the 10s
  // poll — the fresh task arrives within milliseconds of the spec-field POST.
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      SPEC_FIELD_UPDATE_EVENT,
      () => { void fetchTasks() },
    )
    return () => unsub()
  }, [fetchTasks])

  // Keep the open modal's task in sync with the latest fetched row (version/
  // status) — same pattern as the v1 SchedulerJob sync, now against Task.
  const tasksRef = useRef<Task[]>(tasks)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => {
    if (!modalOpen || !modalTask) return
    const fresh = tasksRef.current.find((t) => t.id === modalTask.id)
    if (fresh && fresh !== modalTask) setModalTask(fresh)
  }, [tasks, modalOpen, modalTask])

  const openNew = () => { setModalTask(null); setModalOpen(true) }
  const openCard = (task: Task) => { setModalTask(task); setModalOpen(true) }
  const close = () => { setModalOpen(false); setModalTask(null) }

  // Delete a draft task (soft-delete). Only draft tasks are deletable from
  // the kanban card; non-draft tasks require abort-first (server 409 guard).
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const handleDeleteDraft = useCallback(async (taskId: string) => {
    setDeleteBusy(true)
    try {
      await deleteTask(taskId)
      toast.success("草稿已废弃")
      setDeletingTaskId(null)
      // Close the modal if the deleted task was open
      if (modalTask?.id === taskId) close()
      void fetchTasks()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeleteBusy(false)
    }
  }, [fetchTasks, modalTask])

  // New-task flow: the task-author clone + autosave seam (04) create a draft
  // (linked via source_chat_session_id); adopt it so [入队] enables without
  // closing the modal.
  const handleDraftResolved = useCallback((draft: Task) => {
    setModalTask(draft)
    void fetchTasks()
  }, [fetchTasks])

  const grouped = groupTasksByStatus(tasks)

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex flex-col h-full min-w-0">
        <header className="flex items-center gap-3 px-6 py-4 border-b border-border">
          <h1 className="text-2xl font-bold tracking-tight">任务看板</h1>
          <span className="text-sm text-muted-foreground">{tasks.length} 个任务</span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchTasks} disabled={loading}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button size="sm" onClick={openNew} data-task-new>
              <Plus className="size-4" />
              新建任务
            </Button>
          </div>
        </header>

        {error ? (
          <div className="flex-1 flex items-center justify-center text-destructive text-sm">
            {error}
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <div className="flex gap-3 min-h-full" style={{ minWidth: "max-content" }}>
              {TASK_COLUMNS.map((col) => (
                <section
                  key={col.id}
                  data-task-column={col.id}
                  aria-label={col.label}
                  className="flex flex-col gap-2 w-[220px] shrink-0 rounded-md bg-muted/30"
                >
                  <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <h2 className="text-sm font-semibold">{col.label}</h2>
                    <span className="text-xs text-muted-foreground">{grouped[col.id].length}</span>
                  </header>
                  <div className="flex flex-col gap-2 flex-1 p-2 overflow-auto">
                    {grouped[col.id].map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => openCard(task)}
                        onDeleteRequest={(t) => setDeletingTaskId(t.id)}
                      />
                    ))}
                    {grouped[col.id].length === 0 && (
                      <div
                        data-empty-column={col.id}
                        className="text-xs text-muted-foreground text-center py-6 border border-dashed rounded-md"
                      >
                        空
                      </div>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>

      <TaskModal
        open={modalOpen}
        onOpenChange={(o) => { if (!o) close(); else setModalOpen(true) }}
        task={modalTask}
        onMutated={fetchTasks}
        onDraftResolved={handleDraftResolved}
      />

      {/* Confirm-delete dialog for draft tasks */}
      <AlertDialog open={!!deletingTaskId} onOpenChange={(o) => { if (!o) setDeletingTaskId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>废弃草稿</AlertDialogTitle>
            <AlertDialogDescription>
              确定要废弃这个草稿吗？草稿内容及工作目录将被清理，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault()
                if (deletingTaskId) void handleDeleteDraft(deletingTaskId)
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteBusy ? "删除中…" : "确认废弃"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface TaskCardProps {
  task: Task
  onClick: () => void
  onDeleteRequest: (task: Task) => void
}

function TaskCard({ task, onClick, onDeleteRequest }: TaskCardProps) {
  // SG9: composite requires subunits.length >= 2.
  const composite = !!task.task_spec.subunits && task.task_spec.subunits.length >= 2
  const isDraft = task.status === "draft"
  return (
    <article
      data-task-card
      data-task-id={task.id}
      data-task-status={task.status}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } }}
      className="group rounded-md border border-border bg-card p-3 text-sm shadow-sm cursor-pointer hover:border-primary/40 hover:shadow transition-all relative"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium truncate">{task.name}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {composite ? <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary">复合</span> : null}
          {isDraft && (
            <button
              data-task-delete-btn
              onClick={(e) => { e.stopPropagation(); onDeleteRequest(task) }}
              className="size-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
              title="废弃草稿"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>状态</dt>
          <dd data-task-card-status>{task.status}</dd>
        </div>
        <div className="flex justify-between">
          <dt>创建</dt>
          <dd>{new Date(task.created_at).toLocaleString()}</dd>
        </div>
      </dl>
    </article>
  )
}
