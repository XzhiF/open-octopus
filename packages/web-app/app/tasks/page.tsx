"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSearchParams } from "next/navigation"
import { RefreshCw, Plus, Trash2, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import type { Task } from "@octopus/shared"
import { listTasks, deleteTask, getTask, postAdvance, postArchiveRetry, TaskApiError, type TaskDerivedView } from "@/lib/tasks-api"
import { toast } from "sonner"
import {
  groupTasksByStatus, tasksForColumn, effectiveStatusOf, sortByCreatedDesc,
  computePhaseBadge, overBudgetRoundOf, phaseBudgetMs, TASK_COLUMNS,
  type TaskBoardColumnId,
} from "@/lib/task-board"
import { formatRelativeTime } from "@/lib/format"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { TaskModal } from "@/components/tasks/task-modal"
import { TriggerDialog } from "@/components/tasks/trigger-dialog"
import { AcceptanceModal } from "@/components/tasks/acceptance-modal"
import {
  TASK_STATUS_EVENT, SPEC_FIELD_UPDATE_EVENT, TASK_TRIGGER_EVENT,
  PHASE_STATUS_UPDATE_EVENT,
} from "@octopus/shared"

const REFRESH_INTERVAL_MS = 10_000

/** 看板状态色彩体系 🎪 Memphis 波普贴纸版:一状态一糖果色,列头彩色吊牌 +
 *  泳道轻染 + 卡片整面染色(歪斜/hover 浮起由 .pop-tilt 统一驱动)。
 *  全部为静态 class 字面量（Tailwind JIT）。 */
const COLUMN_THEME: Record<TaskBoardColumnId, {
  lane: string; head: string; label: string; dot: string; pill: string
}> = {
  draft: {
    lane: "bg-pop-paper",
    head: "bg-pop-idle",
    label: "text-pop-dim",
    dot: "bg-pop-dim",
    pill: "bg-pop-paper text-pop-dim",
  },
  ready: {
    lane: "bg-pop-cyan-soft/25",
    head: "bg-pop-cyan-soft",
    label: "text-cyan-800 dark:text-cyan-200",
    dot: "bg-pop-cyan",
    pill: "bg-pop-paper text-cyan-800 dark:text-cyan-200",
  },
  running: {
    lane: "bg-pop-purple-soft/30",
    head: "bg-pop-purple-soft",
    label: "text-pop-purple",
    dot: "bg-pop-purple",
    pill: "bg-pop-paper text-pop-purple",
  },
  awaiting_review: {
    lane: "bg-pop-amber-soft/30",
    head: "bg-pop-amber-soft",
    label: "text-amber-800 dark:text-amber-200",
    dot: "bg-pop-amber",
    pill: "bg-pop-paper text-amber-800 dark:text-amber-200",
  },
  done: {
    lane: "bg-pop-green-soft/25",
    head: "bg-pop-green-soft",
    label: "text-green-800 dark:text-green-200",
    dot: "bg-pop-green",
    pill: "bg-pop-paper text-green-800 dark:text-green-200",
  },
}

/** 卡片整面染色:八状态各一贴纸底(黑边硬影外形统一,由 .pop-tilt 列容器驱动)。 */
const CARD_THEME: Record<Task["status"], string> = {
  draft: "bg-pop-paper",
  ready: "bg-pop-cyan-soft",
  running: "bg-pop-purple-soft",
  archiving: "bg-pop-amber-soft",
  awaiting_review: "bg-pop-yellow-soft",
  done: "bg-pop-green-soft",
  failed: "bg-pop-pink-soft",
  aborted: "bg-pop-idle",
}

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

  // 票 12 (K14): which task has the 验收三栏 modal open (待验收列卡「验收」按钮).
  const [acceptTaskId, setAcceptTaskId] = useState<string | null>(null)

  // 票 12 (US11/K6): autoAdvance=false 时「启动下一 Phase」— POST /:id/advance
  // (票 08 契约). Busy-guard per click; 409 = 派生态已变 → 刷新盘面.
  const [advanceBusyId, setAdvanceBusyId] = useState<string | null>(null)
  const handleAdvance = useCallback(async (task: Task) => {
    if (advanceBusyId) return
    setAdvanceBusyId(task.id)
    try {
      const result = await postAdvance(task.id)
      toast.success(`Phase ${result.dispatch?.phase_index ?? "?"} Round ${result.dispatch?.round_index ?? 1} 已开跑`)
      void fetchTasks()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "启动失败")
      if (err instanceof TaskApiError && err.status === 409) void fetchTasks()
    } finally {
      setAdvanceBusyId(null)
    }
  }, [advanceBusyId, fetchTasks])

  // 票 12 (US15): archiving 卡「重试归档」— POST /:id/archive/retry (票 08 幂等续跑).
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null)
  const handleArchiveRetry = useCallback(async (task: Task) => {
    if (retryBusyId) return
    setRetryBusyId(task.id)
    try {
      await postArchiveRetry(task.id)
      toast.success("归档续跑已触发 — 完成以 task_status(done) 为准")
      void fetchTasks()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "重试归档失败")
      if (err instanceof TaskApiError && err.status === 409) void fetchTasks()
    } finally {
      setRetryBusyId(null)
    }
  }, [retryBusyId, fetchTasks])

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
  // sortByCreatedDesc 在装桶前过一次：groupTasksByStatus 按迭代序 push，
  // 每列因此天然「新→旧」（用户要求列内从新到旧）。
  const displayTasks = tasks.map((t) => {
    const eff = effectiveStatusOf(t, derivedMap[t.id])
    return eff === t.status ? t : { ...t, status: eff }
  })
  const grouped = groupTasksByStatus(sortByCreatedDesc(displayTasks))
  const budgetMs = phaseBudgetMs()

  return (
    <div className="pop-confetti flex flex-1 min-h-0 flex-col text-pop-ink">
      <div className="flex flex-col h-full min-w-0">
        <header className="flex items-center gap-3 px-6 py-3 border-b-[2.5px] border-pop-bd bg-pop-paper">
          <h1 className="text-lg font-black tracking-tight">任务看板</h1>
          <span className="rounded-full border-2 border-pop-bd bg-pop-yellow px-2 py-0.5 text-xs font-black tabular-nums shadow-pop-sm">{tasks.length} 个任务</span>
          <div className="ml-auto flex gap-2">
            <Button variant="pop-quiet" size="sm" onClick={fetchTasks} disabled={loading}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button variant="pop" size="sm" onClick={openNew} data-task-new>
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
          <div className="flex-1 min-h-0 overflow-auto p-4">
            {/* 泳道等分占满：min-w-[1240px] 保 5 道最低可读宽（窄屏出横向滚动），
                各列 flex-1 basis-0 均分 —— 宽屏不再留右侧死空间。 */}
            <div className="flex h-full min-w-[1240px] gap-3">
              {TASK_COLUMNS.map((col) => {
                const colTasks = tasksForColumn(grouped, col.id)
                const theme = COLUMN_THEME[col.id]
                return (
                <section
                  key={col.id}
                  data-task-column={col.id}
                  aria-label={col.label}
                  className={`flex min-w-0 flex-1 basis-0 flex-col overflow-hidden rounded-xl border-[2.5px] border-pop-bd shadow-pop-sm ${theme.lane}`}
                >
                  <header className={`flex items-center gap-2 border-b-2 border-pop-bd px-3 py-2 text-xs font-black ${theme.head}`}>
                    <span className={`size-2 shrink-0 rounded-[3px] border-[1.5px] border-pop-bd ${theme.dot}`} aria-hidden />
                    <span className={theme.label}>{col.label}</span>
                    <span className={`ml-auto rounded-full border-2 border-pop-bd px-1.5 py-px text-[10px] font-black tabular-nums shadow-[2px_2px_0_rgba(28,27,34,.13)] ${theme.pill}`}>{colTasks.length}</span>
                  </header>
                  <div className="pop-tilt flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                    {colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        derived={derivedMap[task.id]}
                        budgetMs={budgetMs}
                        onClick={() => openCard(task)}
                        onDeleteRequest={(t) => setDeletingTaskId(t.id)}
                        onTriggerRequest={(t) => setTriggerTaskId(t.id)}
                        onAcceptRequest={(t) => setAcceptTaskId(t.id)}
                        onAdvanceRequest={(t) => void handleAdvance(t)}
                        onArchiveRetryRequest={(t) => void handleArchiveRetry(t)}
                      />
                    ))}
                    {colTasks.length === 0 && (
                      <div
                        data-empty-column={col.id}
                        className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-pop-bd/30 text-[11px] font-bold text-pop-dim/70"
                      >
                        <Inbox className="size-4" aria-hidden />
                        暂无任务
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

      {/* 票 12 (K14): 验收三栏 modal — 待验收列卡「验收」打开；task 引用随
          fetchTasks 刷新（同 modalTask 的同步模式）。 */}
      <AcceptanceModal
        open={!!acceptTaskId}
        onOpenChange={(o) => { if (!o) setAcceptTaskId(null) }}
        task={tasks.find((t) => t.id === acceptTaskId) ?? null}
        onMutated={fetchTasks}
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
  /** 票 12: 待验收卡「验收」→ 三栏 modal。 */
  onAcceptRequest: (task: Task) => void
  /** 票 12 (US11): autoAdvance=false parked 卡「启动下一 Phase」→ postAdvance。 */
  onAdvanceRequest: (task: Task) => void
  /** 票 12 (US15): archiving 卡「重试归档」→ archive/retry。 */
  onArchiveRetryRequest: (task: Task) => void
}

/** 票 12: advance 窗口 = 「前序 phase accepted ∧ 该 phase pending」的第一个
 *  pending 位置（与 server advancePhase 的派生判定同源）。 */
function advancePhaseOf(derived: TaskDerivedView | undefined): number | null {
  if (!derived?.isV4) return null
  const views = derived.phaseViews
  for (let pos = 1; pos < views.length; pos++) {
    if (views[pos - 1].status === "accepted" && views[pos].status === "pending") return views[pos].index
  }
  return null
}

function TaskCard({ task, derived, budgetMs, onClick, onDeleteRequest, onTriggerRequest, onAcceptRequest, onAdvanceRequest, onArchiveRetryRequest }: TaskCardProps) {
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
      className={`group relative cursor-pointer rounded-xl border-[2.5px] border-pop-bd p-3 text-sm shadow-pop-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pop-bd ${
        CARD_THEME[task.status] ?? "bg-pop-paper"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-black truncate text-pop-ink">{task.name}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {composite ? <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-pop-bd bg-pop-pink-soft text-pop-pink">复合</span> : null}
          {/* 票 11: v4 phase 角标（US7） */}
          {badge && (
            <span
              data-task-phase-badge
              className="text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-pop-bd bg-pop-purple-soft text-pop-purple tabular-nums"
              title={`当前 Phase ${badge.phase}/${badge.total}（第一个未通过验收的 phase）`}
            >
              {`Phase ${badge.phase}/${badge.total}${badge.round != null ? ` · Round ${badge.round}` : ""}`}
            </span>
          )}
          {/* 票 11: archiving 留在执行中列 + ⚠归档中徽标（票 08 编排中，失败可重试） */}
          {task.status === "archiving" && (
            <span
              data-task-archiving-badge
              className="text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-pop-bd bg-pop-amber-soft text-amber-800 dark:text-amber-200"
              title="末 phase 已验收，归档编排中（git 失败会停在此态可重试）"
            >
              ⚠ 归档中
            </span>
          )}
          {/* 票 11 AC4: ⏳ 超预算（advisory；阈值 NEXT_PUBLIC_PHASE_BUDGET_MS ?? 1.5h） */}
          {overBudget && (
            <span
              data-task-overbudget-badge
              className="text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-pop-bd bg-pop-yellow-soft text-amber-800 dark:text-amber-200"
              title={`Phase ${overBudget.phaseIndex} Round ${overBudget.roundIndex} 已跑超 ${Math.round(budgetMs / 60000)} 分钟（仅提示，不中断）`}
            >
              ⏳ 超预算
            </span>
          )}
          {isQueuedRun && (
            <span
              data-task-queued-badge
              className="text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-pop-bd bg-pop-yellow-soft text-amber-800 dark:text-amber-200"
              title={`定时触发：${new Date(task.scheduled_at!).toLocaleString()}`}
            >
              {new Date(task.scheduled_at!).getTime() > Date.now()
                ? `已排队 · ${new Date(task.scheduled_at!).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 触发`
                : "排队等待执行"}
            </span>
          )}
          {/* 完成列折叠了 done/failed/aborted 三终态 — 用彩色 chip 自证真实终态
              （替代原英文 status 行；data-task-card-status 语义迁移到此）。 */}
          {(task.status === "failed" || task.status === "aborted") && (
            <span
              data-task-card-status
              className={`text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-pop-bd ${
                task.status === "failed"
                  ? "bg-pop-pink-soft text-pop-red"
                  : "bg-pop-idle text-pop-dim"
              }`}
            >
              {task.status === "failed" ? "失败" : "已中止"}
            </span>
          )}
          {/* 票 12 (K14/US9): 待验收卡「验收」→ 三栏证据面 modal */}
          {isAwaitingReview && (
            <button
              data-task-accept-btn
              onClick={(e) => { e.stopPropagation(); onAcceptRequest(task) }}
              className="h-5 rounded-lg border-2 border-pop-bd px-2 text-[10px] font-black shadow-pop-sm pop-press bg-pop-yellow text-pop-ink"
              title="打开验收三栏（执行摘要 | 产物核对 | 动作区）"
            >
              验收
            </button>
          )}
          {/* v4 advance-window 卡改显「启动下一 Phase」（下方按钮）——触发只对
              首 phase（信封 parked）成立，信封已消费的 parked 卡走 advance。 */}
          {isReady && advancePhaseOf(derived) === null && (
            <button
              data-task-trigger-btn
              onClick={(e) => { e.stopPropagation(); onTriggerRequest(task) }}
              className="h-5 rounded-lg border-2 border-pop-bd px-2 text-[10px] font-black shadow-pop-sm pop-press bg-pop-purple text-white"
              title="人工触发（立即或定时）"
            >
              触发
            </button>
          )}
          {/* 票 12 (K6/US11): autoAdvance=false parked — 前序 accepted ∧ 该 phase
              pending 的窗口走 POST /:id/advance（票 08 契约；首 phase 仍走触发） */}
          {advancePhaseOf(derived) !== null && (
            <button
              data-task-advance-btn={advancePhaseOf(derived) ?? ""}
              onClick={(e) => { e.stopPropagation(); onAdvanceRequest(task) }}
              className="h-5 rounded-lg border-2 border-pop-bd px-2 text-[10px] font-black shadow-pop-sm pop-press bg-pop-cyan text-pop-ink"
              title={`启动 Phase ${advancePhaseOf(derived)}（上一 Phase 已通过验收，autoAdvance 关闭）`}
            >
              启动下一 Phase
            </button>
          )}
          {/* 票 12 (US15): archiving git 失败停态 → 幂等续跑 */}
          {task.status === "archiving" && (
            <button
              data-task-archive-retry-btn
              onClick={(e) => { e.stopPropagation(); onArchiveRetryRequest(task) }}
              className="h-5 rounded-lg border-2 border-pop-bd px-2 text-[10px] font-black shadow-pop-sm pop-press bg-pop-amber text-pop-ink"
              title="重试归档（project 粒度幂等续跑）"
            >
              重试归档
            </button>
          )}
          {isDraft && (
            <button
              data-task-delete-btn
              onClick={(e) => { e.stopPropagation(); onDeleteRequest(task) }}
              className="size-5 rounded flex items-center justify-center text-pop-dim/60 hover:text-pop-red hover:bg-pop-pink-soft opacity-0 group-hover:opacity-100 transition-all"
              title="废弃草稿"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      </div>
      {/* 列已表达生命周期状态，卡片不再复读英文 status —— 底行只给时间语境 */}
      <div className="mt-2 text-[10px] font-semibold text-pop-dim" title={new Date(task.created_at).toLocaleString()}>
        创建 {formatRelativeTime(task.created_at)}
      </div>
    </article>
  )
}
