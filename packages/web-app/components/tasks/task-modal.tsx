// packages/web-app/components/tasks/task-modal.tsx
//
// TaskModal — the unified task modal for the first-class `tasks` domain
// (v2-D1, SG14 — reads `Task`, NOT `SchedulerJob`). One modal, modes:
// authoring-template ([+新建] 模板页) / authoring-workspace (draft 对话创作) /
// simple-execution / composite / done / terminal. v4-only UI 改版后旧的
// SpecPanel-based AuthoringMode 与其 re-export 已删除；创作走
// AuthoringWorkspace（task-author 对话 + v4 产出面板）。
//
// router.push retarget (SG15): child drill-down →
// `/tasks/:taskId/children/:scheduleId` (was `/scheduler/jobs/:id`).

"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { Ban, AlertCircle, CheckCircle2, Workflow, ExternalLink, Maximize2, Minimize2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, SubunitSpec } from "@octopus/shared"
import {
  getTask, abortTask, deleteTask, type TaskDetail, type TaskChild,
} from "@/lib/tasks-api"
import { TriggerActions } from "@/components/tasks/trigger-dialog"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { useRouter } from "next/navigation"
import { computeAggregateStatus } from "@/lib/composite-status"
import { CompositeDag } from "@/components/tasks/composite-dag"
import { CompositeEventsPanel, type CompositeEvent } from "@/components/tasks/composite-events-panel"
import * as agentApi from "@/lib/agent/api"
import { TemplatePicker } from "./authoring/template-picker"
import { AuthoringWorkspace } from "./authoring/authoring-workspace"
import { EditableTitle } from "./editable-title"
import { TaskRunDetailView } from "./execution-summary"
import { createTask } from "@/lib/tasks-api"

// ── Types ───────────────────────────────────────────────────────────

interface TaskModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = new-task authoring ([+新建]). A draft task opens authoring resumed
   *  on its source_chat_session_id; non-draft opens execution/done/terminal. */
  task: Task | null
  /** Refresh the kanban after a mutation (ready / abort / draft edit). */
  onMutated: () => void
  /** Page adopts a draft the task-author clone just created (new-task flow). */
  onDraftResolved?: (task: Task) => void
}

type ModalMode =
  | "authoring-template"
  | "authoring-workspace"
  | "simple-execution"
  | "composite"
  | "done"
  | "terminal"

const TASK_AUTHOR_CLONE = "task-author"

// ── Helpers ─────────────────────────────────────────────────────────

function taskSpecOf(task: Task | null): TaskSpec | null {
  return task?.task_spec ?? null
}

/** SG9: composite requires subunits.length >= 2 (1-subunit → simple
 *  workflow_chain). The dispatch seam (server) uses the same threshold. */
function isComposite(task: Task | null): boolean {
  const spec = taskSpecOf(task)
  return !!spec && Array.isArray(spec.subunits) && spec.subunits.length >= 2
}

function resolveMode(task: Task | null): ModalMode {
  if (task === null) return "authoring-template"
  if (task.status === "draft") {
    // ALL drafts open the AuthoringWorkspace (chat + v4 产出面板)。v4-only UI
    // 后不再有旧的 SpecPanel-based AuthoringMode（已随契约修复退役）；万一遇到
    // 历史非 v4 draft（清库后理论不存在），workspace 降级显示、入队由 server
    // 409 兜底。
    return "authoring-workspace"
  }
  if (task.status === "ready" || task.status === "running") {
    return isComposite(task) ? "composite" : "simple-execution"
  }
  // task-phase-redesign 票 11 双态分流：v4 的 awaiting_review / archiving 是
  // 「执行期的人机窗口」（验收/归档中），不是终态 — 走执行视图（TaskRunDetail
  // View 顶部 PhaseTimeline；票 12 在此挂验收三栏）。旧逻辑会把它们误入
  // terminal（渲染成「任务已中止」横幅）。
  if (task.status === "awaiting_review" || task.status === "archiving") {
    return isComposite(task) ? "composite" : "simple-execution"
  }
  // done / failed / aborted
  if (task.status === "done") return isComposite(task) ? "composite" : "done"
  return isComposite(task) ? "composite" : "terminal"
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿", ready: "待执行", running: "执行中",
  awaiting_review: "待验收", archiving: "归档中",
  done: "已完成", failed: "失败", aborted: "已中止",
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-blue-500/15 text-blue-500",
  running: "bg-blue-500/15 text-blue-500",
  // K3/US8: 待验收=琥珀（等人放行，非红死）；归档中=橙（票 08 编排中）。
  awaiting_review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  archiving: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  done: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-red-500/15 text-red-500",
  aborted: "bg-zinc-500/15 text-zinc-500",
}

// ── TaskModal ───────────────────────────────────────────────────────

export function TaskModal({ open, onOpenChange, task, onMutated, onDraftResolved }: TaskModalProps) {
  const mode = resolveMode(task)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // Reset fullscreen when modal closes
  useEffect(() => {
    if (!open) setIsFullscreen(false)
  }, [open])

  const handleDeleteDraft = useCallback(async () => {
    if (!task || task.status !== "draft") return
    setDeleteBusy(true)
    try {
      await deleteTask(task.id)
      toast.success("草稿已废弃")
      setDeleteConfirmOpen(false)
      onMutated()
      onOpenChange(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeleteBusy(false)
    }
  }, [task, onMutated, onOpenChange])

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton
          className={
            isFullscreen
              ? "sm:max-w-[100vw] w-screen h-screen max-h-screen p-0 gap-0 flex flex-col !rounded-none border-0"
              : "sm:max-w-[92vw] w-[92vw] max-h-[90vh] h-[90vh] p-0 gap-0 flex flex-col"
          }
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (isFullscreen) {
              e.preventDefault()
              setIsFullscreen(false)
            }
          }}
          overlayClassName={isFullscreen ? "bg-transparent" : undefined}
        >
          <ModalHeader
            task={task}
            mode={mode}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen((f) => !f)}
            onDeleteDraft={() => setDeleteConfirmOpen(true)}
            onMutated={onMutated}
          />
          <div className="flex-1 min-h-0 overflow-hidden">
            {mode === "authoring-template" && (
              <TemplatePickerMode
                onDraftResolved={onDraftResolved ?? (() => {})}
                onMutated={onMutated}
                onClose={() => onOpenChange(false)}
              />
            )}
            {mode === "authoring-workspace" && task && (
              <AuthoringWorkspace task={task} onMutated={onMutated} onClose={() => onOpenChange(false)} />
            )}
            {mode === "simple-execution" && task && (
              <SimpleExecutionMode task={task} onMutated={onMutated} onClose={() => onOpenChange(false)} />
            )}
            {mode === "composite" && task && (
              <CompositeMode task={task} onMutated={onMutated} onClose={() => onOpenChange(false)} />
            )}
            {mode === "done" && task && <DoneMode task={task} />}
            {mode === "terminal" && task && <TerminalMode task={task} />}
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm-delete dialog for draft tasks */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>废弃草稿</AlertDialogTitle>
            <AlertDialogDescription>
              确定要废弃「{task?.name ?? "未命名"}」吗？草稿内容及工作目录将被清理，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              onClick={(e) => { e.preventDefault(); void handleDeleteDraft() }}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteBusy ? "删除中…" : "确认废弃"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ModalHeader({ task, mode, isFullscreen, onToggleFullscreen, onDeleteDraft, onMutated }: {
  task: Task | null; mode: ModalMode; isFullscreen: boolean; onToggleFullscreen: () => void; onDeleteDraft: () => void; onMutated: () => void
}) {
  const status = task?.status ?? "draft"
  const isDraft = status === "draft"
  const subtitle =
    mode === "composite"
      ? "复合任务"
      : mode === "done"
        ? "结果"
        : mode === "terminal"
          ? "终态"
          : mode === "authoring-template" || mode === "authoring-workspace"
            ? "创作"
            : "执行"
  return (
    <DialogHeader className="px-5 py-3 border-b border-border flex-row items-center justify-between space-y-0">
      <div className="min-w-0">
        <EditableTitle task={task} onMutated={onMutated} />
        <DialogDescription className="text-xs">{subtitle}</DialogDescription>
      </div>
      <div className="flex items-center gap-2 shrink-0 mr-8">
        {isDraft && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-red-500 hover:text-red-600 hover:bg-red-500/10"
            onClick={onDeleteDraft}
            data-task-modal-delete
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            废弃草稿
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onToggleFullscreen}
          title={isFullscreen ? "退出全屏 (Esc)" : "全屏"}
        >
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Badge variant="secondary" className={`${STATUS_TONE[status] ?? ""}`} data-task-modal-status={status}>
          {STATUS_LABEL[status] ?? status}
        </Badge>
      </div>
    </DialogHeader>
  )
}

// ── Authoring: template picker → AuthoringWorkspace (v4 two-phase) ────

/** Phase 1 of the v4 flow (D15 会话优先 + 契约修复直建). Renders the
 *  TemplatePicker; on 开始编写, runs the create sequence:
 *    1. POST /api/clones/task-author/sessions  (session FIRST — autosave/
 *       spec-field/SSE all resolve via source_chat_session_id)
 *    2. POST /api/tasks {source_chat_session_id, task_spec:{format:"v4"},
 *       project_ids} → 直建 v4 draft + home + manifest.json 快照（flag 即刻生效，
 *       不再产生 v3 壳、不再等对话中 PUT 翻面）。无 task_type/skill_groups —
 *       matt 技能族随 clone 自动就位（票 09/K15）。
 *  On success, `onDraftResolved(task)` adopts the draft so the parent
 *  re-renders with task set → resolveMode routes to AuthoringWorkspace. */
function TemplatePickerMode({
  onDraftResolved, onMutated, onClose,
}: {
  onDraftResolved: (task: Task) => void
  onMutated: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)

  const handleCreate = async (value: { org?: string; projects: string[] }) => {
    setBusy(true)
    try {
      // D15 step 1: create the chat session FIRST.
      const session = await agentApi.createCloneSession(TASK_AUTHOR_CLONE)
      // D15 step 2 + 契约修复: POST 直建 v4（spec 旗标即刻落地）。
      const task = await createTask({
        org: value.org ?? "default",
        source_chat_session_id: session.id,
        task_spec: { format: "v4" },
        project_ids: value.projects,
      })
      // Adopt the draft → parent re-renders → AuthoringWorkspace (phase 2).
      onDraftResolved(task)
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "创建任务失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full min-h-0" data-task-template-mode>
      <TemplatePicker onCreate={handleCreate} busy={busy} />
    </div>
  )
}

// ── Authoring: spec LEFT / clone chat RIGHT ──────────────────────────
// (旧 AuthoringMode/AuthoringFooter — SpecPanel 左 + 自带旁路入队清单的 v2 面 —
//  自 bugfix 2026-08-19 起对全部 draft 不可达；v4-only UI 改版随契约修复删除。
//  创作一律走 AuthoringWorkspace：task-author 对话 + v4 产出面板。)

// ── Simple execution: full info body + trigger/abort footer ─────────

function SimpleExecutionMode({ task, onMutated, onClose }: { task: Task; onMutated: () => void; onClose: () => void }) {
  const [aborting, setAborting] = useState(false)
  const canAbort = task.status === "running"

  const handleAbort = async () => {
    setAborting(true)
    try {
      await abortTask(task.id)
      toast.success("已中止任务，工作区将清理")
      onMutated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
    } finally {
      setAborting(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-task-simple-execution>
      <div className="flex-1 min-h-0">
        <TaskRunDetailView task={task} />
      </div>
      <div className="shrink-0 flex items-center justify-end gap-2 border-t border-border px-5 py-3 bg-background">
        <TriggerActions task={task} onMutated={onMutated} />
        <Button variant="destructive" size="sm" onClick={handleAbort} disabled={!canAbort || aborting} data-task-abort>
          {aborting ? <Spinner className="size-4" /> : <Ban className="size-4" />}
          中止
        </Button>
      </div>
    </div>
  )
}

// ── Composite: composition DAG + N child cards + integration + SSE ──────

/** Derive a minimal composition DAG from task_spec.subunits (client-side) —
 *  the server's TaskDetail doesn't carry a dag. Nodes = subunits + 1
 *  integration node; edges = each subunit → integration. Keeps the existing
 *  CompositeDag rendering functional; ticket 11 will replace the drill-down. */
function deriveDag(spec: TaskSpec | null): { nodes: { id: string; type: "subunit" | "integration"; label: string; workflow_ref?: string }[]; edges: { from: string; to: string }[] } {
  const subunits = spec?.subunits ?? []
  if (subunits.length === 0) return { nodes: [], edges: [] }
  // Explicit element type so the 'integration' push is assignable to the same
  // array the 'subunit' map produced (TS would otherwise infer the array as
  // { type: "subunit" }[] from the map).
  const nodes: { id: string; type: "subunit" | "integration"; label: string; workflow_ref?: string }[] =
    subunits.map((s: SubunitSpec) => ({
      id: s.name, type: "subunit" as const, label: s.name, workflow_ref: s.workflow_ref,
    }))
  nodes.push({
    id: "integration",
    type: "integration" as const,
    label: spec?.integration_goal?.strategy === "merge" ? "merge" : "synthesis",
  })
  const edges = subunits.map((s: SubunitSpec) => ({ from: s.name, to: "integration" }))
  return { nodes, edges }
}

/** Map TaskDetail.children (server S2 origin lookup) → the JobDetailChild shape
 *  the existing CompositeDag/child-card components consume (name → subunit_name).
 *  Keeps composite-dag.tsx untouched (ticket 11's lane). */
function childrenToDagChildren(children: TaskChild[]): { schedule_id: string; name: string; status: string; workflow_ref: string; subunit_name: string }[] {
  return children.map((c) => ({
    schedule_id: c.schedule_id,
    name: c.name,
    status: c.status,
    workflow_ref: c.workflow_ref ?? "",
    subunit_name: c.name,
  }))
}

function integrationStatusOf(parent: string, children: { status: string }[]): string {
  if (parent === "done" || parent === "failed" || parent === "aborted") return parent
  const allChildrenDone = children.length > 0 && children.every((c) => c.status === "done")
  return allChildrenDone ? "running" : "pending"
}

export function CompositeMode({
  task, onMutated, onClose,
}: {
  task: Task
  onMutated: () => void
  onClose: () => void
}) {
  const router = useRouter()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [aborting, setAborting] = useState(false)
  const [events, setEvents] = useState<CompositeEvent[]>([])

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const data = await getTask(id)
      setDetail(data)
    } catch {
      // Non-fatal: the modal still shows the parent row from props.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchDetail(task.id)
  }, [task.id, fetchDetail])

  // ticket 11 (AC2): the SSE handlers must read the LATEST children without
  // re-subscribing on every refetch. detailRef mirrors `detail` so the effect
  // deps stay [task.id, fetchDetail] (both stable) — the subscription survives
  // refetches and no events are missed in a tear-down/re-create gap.
  const detailRef = useRef<TaskDetail | null>(null)
  useEffect(() => {
    detailRef.current = detail
  }, [detail])

  // Real-time SSE on /api/tasks/events. The server's `taskpool` channel carries
  // TWO event types this drill-down cares about (both forwarded by the route):
  //  - task_status    {task_id, status, schedule_id, origin_type}  — parent
  //                    mirror emitted by ScheduleStatusListener (SG2) when a
  //                    child schedule transition mirrors onto tasks.status.
  //  - schedule_status {schedule_id, status}                       — per-schedule
  //                    transitions emitted by task-dispatch-service (child
  //                    queued/running, SG10) + workflow-executor (running/done/
  //                    failed). These are the most frequent child signals; without
  //                    this subscription child cards only refresh on the slower
  //                    parent-mirror event (ticket 10's minimal wiring).
  useEffect(() => {
    if (!task.id) return
    const eventsUrl = `${getServerUrl()}/api/tasks/events`
    const parentLabel = "父任务"

    const labelFor = (scheduleId: string): string => {
      if (scheduleId === task.id) return parentLabel
      const child = detailRef.current?.children?.find((c) => c.schedule_id === scheduleId)
      return child?.name ?? scheduleId.slice(0, 8)
    }
    // Relevance: task_status is relevant if task_id is the parent OR a known
    // child schedule_id; schedule_status is relevant only for known children.
    const isChildSchedule = (scheduleId: string): boolean =>
      detailRef.current?.children?.some((c) => c.schedule_id === scheduleId) ?? false

    const pushEvent = (scheduleId: string, status: string) => {
      setEvents((prev) => [
        ...prev,
        {
          schedule_id: scheduleId,
          status,
          label: labelFor(scheduleId),
          at: new Date().toISOString(),
        },
      ])
    }

    const onTaskStatus = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { task_id: string; status: string; schedule_id?: string }
        const isParent = payload.task_id === task.id
        const isChild = payload.schedule_id ? isChildSchedule(payload.schedule_id) : false
        if (!isParent && !isChild) return
        pushEvent(payload.schedule_id ?? payload.task_id, payload.status)
        void fetchDetail(task.id)
      } catch {
        // Malformed event payload — ignore.
      }
    }

    const onScheduleStatus = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { schedule_id: string; status: string }
        // schedule_status fires for EVERY schedule on the taskpool channel
        // (incl. cron jobs unrelated to this task). Filter to this task's children
        // so an unrelated transition doesn't trigger a spurious refetch.
        if (!isChildSchedule(payload.schedule_id)) return
        pushEvent(payload.schedule_id, payload.status)
        void fetchDetail(task.id)
      } catch {
        // Malformed event payload — ignore.
      }
    }

    const unsubTaskStatus = subscribeSSE(eventsUrl, "task_status", onTaskStatus)
    const unsubScheduleStatus = subscribeSSE(eventsUrl, "schedule_status", onScheduleStatus)
    return () => {
      unsubTaskStatus()
      unsubScheduleStatus()
    }
  }, [task.id, fetchDetail])

  const children = detail?.children ?? []
  const dagChildren = childrenToDagChildren(children)
  const dag = deriveDag(taskSpecOf(task))
  const parentStatus = detail?.status ?? task.status
  const aggregate = computeAggregateStatus(dagChildren, parentStatus)
  const integrationStatus = integrationStatusOf(parentStatus, children)
  const canAbort = parentStatus === "running"

  // SG15: retarget child drill-down to the tasks domain. 弹窗优化 (2026-08-29):
  // /tasks/:id/children/:sid 页面并不存在（点了 404）——一旦 children 带上
  // workspace/execution 引用（children[].execution_ref），直接深链到 workspace
  // 页的执行详情面板；否则保留原路由（现状不变，等 ticket 11 落地该页）。
  const handleChildClick = useCallback((scheduleId: string) => {
    const child = detailRef.current?.children?.find((c) => c.schedule_id === scheduleId)
    const ws = child?.execution_ref?.workspace_id ?? child?.workspace_id
    const exec = child?.execution_ref?.execution_id
    if (ws) {
      router.push(exec ? `/workspaces/${ws}?tab=detail&execId=${exec}` : `/workspaces/${ws}`)
      return
    }
    router.push(`/tasks/${task.id}/children/${scheduleId}`)
  }, [router, task.id])

  if (loading && !detail) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="size-5" />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] h-full min-h-0" data-task-composite>
      <div className="flex flex-col min-h-0 overflow-y-auto">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-primary" />
            <span className="text-sm font-medium">聚合状态</span>
            <Badge variant="secondary" className={STATUS_TONE[aggregate] ?? ""} data-testid="composite-aggregate-status">
              {STATUS_LABEL[aggregate] ?? aggregate}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{children.length} 个子任务</span>
        </div>

        {dag.nodes.length > 0 ? (
          <div className="px-2 py-3 border-b border-border">
            <CompositeDag
              dag={dag}
              children={dagChildren}
              integrationStatus={integrationStatus}
              onChildClick={(name) => {
                const child = children.find((c) => c.name === name)
                if (child) handleChildClick(child.schedule_id)
              }}
            />
          </div>
        ) : (
          <div className="px-4 py-6 text-xs text-muted-foreground">等待 composition DAG…</div>
        )}

        <div className="p-3 space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">子任务执行</h3>
          {children.map((c) => (
            <button
              key={c.schedule_id}
              data-testid={`composite-child-${c.schedule_id}`}
              onClick={() => handleChildClick(c.schedule_id)}
              className="w-full text-left rounded-md border border-border bg-card p-2.5 hover:border-primary/40 hover:shadow-sm transition-all flex items-center gap-2"
            >
              <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[c.status] ?? "bg-muted-foreground"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.name}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="text-[10px]">{c.workflow_ref ?? "—"}</code>
                  <span>·</span>
                  <span>{STATUS_LABEL[c.status] ?? c.status}</span>
                  {c.origin_role ? <span className="text-[10px] px-1 rounded bg-muted">{c.origin_role}</span> : null}
                </div>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
            </button>
          ))}
          {children.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">子任务尚未派发。</p>
          )}
        </div>

        <div className="px-3 pb-3" data-testid="composite-integration">
          <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 p-2.5 flex items-center gap-2">
            <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[integrationStatus] ?? "bg-muted-foreground"}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">整合节点</div>
              <div className="text-xs text-muted-foreground">
                {taskSpecOf(task)?.integration_goal?.strategy === "merge" ? "merge" : "synthesis (moa 聚合)"}
              </div>
            </div>
            <Badge variant="secondary" className={STATUS_TONE[integrationStatus] ?? ""}>
              {STATUS_LABEL[integrationStatus] ?? integrationStatus}
            </Badge>
          </div>
        </div>

        {(canAbort || task.status === "ready") && (
          <div className="flex items-center justify-end gap-2 px-3 pb-4">
            <TriggerActions task={task} onMutated={onMutated} />
            {canAbort && (
            <Button variant="destructive" size="sm" onClick={async () => {
              setAborting(true)
              try {
                await abortTask(task.id)
                toast.success("已中止任务，工作区将清理")
                onMutated()
                onClose()
              } catch (err: unknown) {
                toast.error(err instanceof Error ? err.message : "中止失败")
              } finally {
                setAborting(false)
              }
            }} disabled={aborting} data-task-abort>
              {aborting ? <Spinner className="size-4" /> : <Ban className="size-4" />}
              中止
            </Button>
            )}
          </div>
        )}
      </div>

      <div className="border-l border-border min-h-0">
        <CompositeEventsPanel events={events} />
      </div>
    </div>
  )
}

const STATUS_DOT_COLOR: Record<string, string> = {
  queued: "bg-blue-500",
  claimed: "bg-amber-500",
  running: "bg-blue-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  aborted: "bg-zinc-500",
  pending: "bg-muted-foreground",
}

function DoneMode({ task }: { task: Task }) {
  return (
    <div className="flex flex-col h-full min-h-0" data-task-done>
      <div className="shrink-0 flex items-center gap-2 border-b border-emerald-500/30 bg-emerald-500/5 px-5 py-2.5 text-sm text-emerald-600">
        <CheckCircle2 className="size-4" /> 任务完成{task.completed_at ? ` · ${new Date(task.completed_at).toLocaleString("zh-CN")}` : ""}
      </div>
      <div className="flex-1 min-h-0">
        <TaskRunDetailView task={task} />
      </div>
    </div>
  )
}

function TerminalMode({ task }: { task: Task }) {
  const failed = task.status === "failed"
  return (
    <div className="flex flex-col h-full min-h-0" data-task-terminal>
      <div className={`shrink-0 flex items-center gap-2 border-b px-5 py-2.5 text-sm ${failed ? "border-red-500/30 bg-red-500/5 text-red-500" : "border-zinc-500/30 bg-zinc-500/5 text-zinc-500 dark:text-zinc-400"}`}>
        {failed ? <AlertCircle className="size-4" /> : <Ban className="size-4" />}
        {failed ? "任务失败" : "任务已中止"}
        <span className="ml-auto text-xs text-muted-foreground font-normal">
          {failed ? "失败为终态 (G2)，不会自动重派，可新建任务重试" : "中止为终态，工作区已清理"}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <TaskRunDetailView task={task} />
      </div>
    </div>
  )
}
