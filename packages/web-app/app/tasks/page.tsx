"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSearchParams } from "next/navigation"
import { RefreshCw, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import type { Task } from "@octopus/shared"
import { listTasks, deleteTask, getTask, type TaskDerivedView } from "@/lib/tasks-api"
import { toast } from "sonner"
import {
  groupTasksByStatus, tasksForColumn, effectiveStatusOf,
  computePhaseBadge, overBudgetRoundOf, phaseBudgetMs, TASK_COLUMNS,
} from "@/lib/task-board"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { TaskModal } from "@/components/tasks/task-modal"
import { TriggerDialog } from "@/components/tasks/trigger-dialog"
import {
  TASK_STATUS_EVENT, SPEC_FIELD_UPDATE_EVENT, TASK_TRIGGER_EVENT,
  PHASE_STATUS_UPDATE_EVENT,
} from "@octopus/shared"

const REFRESH_INTERVAL_MS = 10_000

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // null task = new-task authoring ([+新建]); a Task = card click.
  const [modalTask, setModalTask] = useState<Task | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  // task-phase-redesign 票 11: v4 卡片的列归属/角标/⏳ 都读 derived
  // （deriveTaskView 唯一真相，票 07 嵌在 GET /:id 上 — list 端点不带）。
  // 看板 v4 任务量小：每次列表刷新后对 format==="v4" 的行逐个补拉 detail。
  const [derivedMap, setDerivedMap] = useState<Record<string, TaskDerivedView>>({})

  const fetchTasks = useCallback(async () => {
    try {
      // GET /api/tasks — first-class tasks domain (SG14: read Task, not
      // SchedulerJob). No trigger_source filter (that was the old schedules
      // hack); the tasks table owns the lifecycle directly.
      const data = await listTasks()
      setTasks(data.items)
      setError(null)

      const v4Ids = data.items
        .filter((t) => t.task_spec?.format === "v4")
        .map((t) => t.id)
      if (v4Ids.length === 0) {
        setDerivedMap({})
      } else {
        const entries = await Promise.all(
          v4Ids.map(async (id) => {
            try {
              const detail = await getTask(id)
              return [id, detail.derived] as const
            } catch {
              return [id, undefined] as const
            }
          }),
        )
        // best-effort：detail 失败/旧 server 无 derived 字段 → 该卡退回持久态归列
        setDerivedMap(Object.fromEntries(
          entries.filter((e): e is [string, TaskDerivedView] => e[1] !== undefined),
        ))
      }
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

  // v39 task_trigger: a manual/time trigger was armed or a pending timed
  // trigger cancelled — refresh so the 「已排队 · … 触发」 badge / column
  // position updates without waiting for the 10s poll.
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      TASK_TRIGGER_EVENT,
      () => { void fetchTasks() },
    )
    return () => unsub()
  }, [fetchTasks])

  // 票 11/⑦: phase_status_update (task-phase-redesign, 票 07 验收链路 emit) —
  // re-derive nudge：列归属/角标以 GET /:id 的 derived 为准（K3 派生不存），
  // 收到即整盘刷新（含 derivedMap 补拉）。常量从 shared 导入。
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      PHASE_STATUS_UPDATE_EVENT,
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

  // Deep link: /tasks?task=<id> (emitted by the scheduler table's 任务 origin
  // badge). Opens that task's modal once the fetched board contains it; the
  // ref guard means a manual close is not re-opened by the next 10s poll.
  const searchParams = useSearchParams()
  const deepLinkAppliedRef = useRef(false)
  useEffect(() => {
    if (deepLinkAppliedRef.current || modalOpen || tasks.length === 0) return
    const targetId = searchParams.get("task")
    if (!targetId) return
    const match = tasks.find((t) => t.id === targetId)
    if (match) {
      deepLinkAppliedRef.current = true
      openCard(match)
    }
  }, [tasks, modalOpen, searchParams])

  // Delete a draft task (soft-delete). Only draft tasks are deletable from
  // the kanban card; non-draft tasks require abort-first (server 409 guard).
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // v39: which ready task has the trigger dialog open.
  const [triggerTaskId, setTriggerTaskId] = useState<string | null>(null)

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

  // 票 11 (K3): v4 列归属用 **derived.taskStatus 优先**（持久 done/failed 镜像
  // 会把待验收任务错归「完成」列 — 票 07 活体交互 #1），再按八桶分组、五列
  // 展平渲染（archiving→执行中, failed/aborted→完成(终态)）。
  const displayTasks = tasks.map((t) => {
    const eff = effectiveStatusOf(t, derivedMap[t.id])
    return eff === t.status ? t : { ...t, status: eff }
  })
  const grouped = groupTasksByStatus(displayTasks)
  const budgetMs = phaseBudgetMs()

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
              {TASK_COLUMNS.map((col) => {
                const colTasks = tasksForColumn(grouped, col.id)
                return (
                <section
                  key={col.id}
                  data-task-column={col.id}
                  aria-label={col.label}
                  className={`flex flex-col gap-2 w-[220px] shrink-0 rounded-md ${col.id === "awaiting_review" ? "bg-amber-500/5 ring-1 ring-inset ring-amber-500/30" : "bg-muted/30"}`}
                >
                  <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <h2 className={`text-sm font-semibold ${col.id === "awaiting_review" ? "text-amber-600 dark:text-amber-400" : ""}`}>{col.label}</h2>
                    <span className="text-xs text-muted-foreground">{colTasks.length}</span>
                  </header>
                  <div className="flex flex-col gap-2 flex-1 p-2 overflow-auto">
                    {colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        derived={derivedMap[task.id]}
                        budgetMs={budgetMs}
                        onClick={() => openCard(task)}
                        onDeleteRequest={(t) => setDeletingTaskId(t.id)}
                        onTriggerRequest={(t) => setTriggerTaskId(t.id)}
                      />
                    ))}
                    {colTasks.length === 0 && (
                      <div
                        data-empty-column={col.id}
                        className="text-xs text-muted-foreground text-center py-6 border border-dashed rounded-md"
                      >
                        空
                      </div>
                    )}
                  </div>
                </section>
                )
              })}
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

      {/* v39 trigger dialog — armed from ready-column cards (or modal) */}
      <TriggerDialog
        open={!!triggerTaskId}
        onOpenChange={(o) => { if (!o) setTriggerTaskId(null) }}
        task={tasks.find((t) => t.id === triggerTaskId) ?? null}
        onTriggered={fetchTasks}
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
  /** v4 派生视图（GET /:id.derived）；undefined = v3/旧 server/未补拉 → 不渲染角标。 */
  derived?: TaskDerivedView
  /** ⏳ 超预算阈值 ms（phaseBudgetMs()）。 */
  budgetMs: number
  onClick: () => void
  onDeleteRequest: (task: Task) => void
  onTriggerRequest: (task: Task) => void
}

function TaskCard({ task, derived, budgetMs, onClick, onDeleteRequest, onTriggerRequest }: TaskCardProps) {
  // SG9: composite requires subunits.length >= 2.
  const composite = !!task.task_spec.subunits && task.task_spec.subunits.length >= 2
  const isDraft = task.status === "draft"
  const isReady = task.status === "ready"
  // 票 11: 待验收卡琥珀高亮 (K3/US8)。
  const isAwaitingReview = task.status === "awaiting_review"
  // v4 角标 `Phase i/n · Round m`（computePhaseBadge：current=第一个非 accepted
  // 的 phase 位置；round=awaitingRound ?? currentRound）。
  const badge = computePhaseBadge(derived)
  // ⏳ 超预算（advisory, K2/US17）：仅在跑轮 now-created_at > budgetMs。
  const overBudget = overBudgetRoundOf(derived, Date.now(), budgetMs)
  // v39: task mirrored 'running' but its root schedule is still 'queued' =
  // armed one-shot not yet due (v39 manual/time trigger; claimed/running are
  // NOT flagged here — the kanban badge only covers the waiting window).
  const isQueuedRun =
    task.status === "running" && task.schedule_status === "queued" && !!task.scheduled_at
  return (
    <article
      data-task-card
      data-task-id={task.id}
      data-task-status={task.status}
      {...(isAwaitingReview ? { "data-task-awaiting-review": "true" } : {})}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } }}
      className={`group rounded-md border p-3 text-sm shadow-sm cursor-pointer hover:shadow transition-all relative ${
        isAwaitingReview
          ? "border-amber-400/60 bg-amber-500/5 hover:border-amber-400"
          : "border-border bg-card hover:border-primary/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium truncate">{task.name}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {composite ? <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary">复合</span> : null}
          {/* 票 11: v4 phase 角标（US7） */}
          {badge && (
            <span
              data-task-phase-badge
              className="text-[10px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 tabular-nums"
              title={`当前 Phase ${badge.phase}/${badge.total}（第一个未通过验收的 phase）`}
            >
              {`Phase ${badge.phase}/${badge.total}${badge.round != null ? ` · Round ${badge.round}` : ""}`}
            </span>
          )}
          {/* 票 11: archiving 留在执行中列 + ⚠归档中徽标（票 08 编排中，失败可重试） */}
          {task.status === "archiving" && (
            <span
              data-task-archiving-badge
              className="text-[10px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-600 dark:text-orange-400"
              title="末 phase 已验收，归档编排中（git 失败会停在此态可重试）"
            >
              ⚠ 归档中
            </span>
          )}
          {/* 票 11 AC4: ⏳ 超预算（advisory；阈值 NEXT_PUBLIC_PHASE_BUDGET_MS ?? 1.5h） */}
          {overBudget && (
            <span
              data-task-overbudget-badge
              className="text-[10px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400"
              title={`Phase ${overBudget.phaseIndex} Round ${overBudget.roundIndex} 已跑超 ${Math.round(budgetMs / 60000)} 分钟（仅提示，不中断）`}
            >
              ⏳ 超预算
            </span>
          )}
          {isQueuedRun && (
            <span
              data-task-queued-badge
              className="text-[10px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400"
              title={`定时触发：${new Date(task.scheduled_at!).toLocaleString()}`}
            >
              {new Date(task.scheduled_at!).getTime() > Date.now()
                ? `已排队 · ${new Date(task.scheduled_at!).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 触发`
                : "排队等待执行"}
            </span>
          )}
          {isReady && (
            <button
              data-task-trigger-btn
              onClick={(e) => { e.stopPropagation(); onTriggerRequest(task) }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              title="人工触发（立即或定时）"
            >
              触发
            </button>
          )}
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
          <dd data-task-card-status className={isAwaitingReview ? "text-amber-600 dark:text-amber-400" : undefined}>{task.status}</dd>
        </div>
        <div className="flex justify-between">
          <dt>创建</dt>
          <dd>{new Date(task.created_at).toLocaleString()}</dd>
        </div>
      </dl>
    </article>
  )
}
