// packages/web-app/components/tasks/task-modal.tsx
//
// TaskModal — the unified task modal for the first-class `tasks` domain
// (v2-D1, SG14 — reads `Task`, NOT `SchedulerJob`). One modal, five modes:
// authoring (draft) / simple-execution / composite / done / terminal. The
// authoring spec↔agent linkage (SpecPanel) lives in spec-panel.tsx; the
// composite DAG / events panel (ticket 11 will replace the drill-down viewer)
// is minimally type-adapted here to read `Task` + `TaskDetail.children`.
//
// router.push retarget (SG15): child drill-down →
// `/tasks/:taskId/children/:scheduleId` (was `/scheduler/jobs/:id`).

"use client"

import { useEffect, useMemo, useState, useCallback, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Send, Ban, AlertCircle, CheckCircle2, Workflow, ExternalLink, Maximize2, Minimize2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, SubunitSpec } from "@octopus/shared"
import {
  listTasks, getTask, readyTask, abortTask, type TaskDetail, type TaskChild,
} from "@/lib/tasks-api"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { useRouter } from "next/navigation"
import { computeAggregateStatus } from "@/lib/composite-status"
import { CompositeDag } from "@/components/tasks/composite-dag"
import { CompositeEventsPanel, type CompositeEvent } from "@/components/tasks/composite-events-panel"
import { SpecPanel, ResourcePicker } from "./spec-panel"
import { useAgentChat } from "@/hooks/useAgentChat"
import { ChatArea } from "@/components/agent/chat/ChatArea"
import * as agentApi from "@/lib/agent/api"
import { TemplatePicker } from "./authoring/template-picker"
import { AuthoringWorkspace } from "./authoring/authoring-workspace"
import { createTask } from "@/lib/tasks-api"

// Re-export the authoring pieces so callers can import everything from the
// modal entrypoint (the SpecPanel test imports from here).
export { SpecPanel, ResourcePicker }

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
  | "authoring"
  | "authoring-v3-template"
  | "authoring-v3-workspace"
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

/** v3 (ticket 09): a task is a v3 two-phase-flow task when task_spec.task_type
 *  is set (it went through the TemplatePicker → create-with-task_type path).
 *  Legacy/v2 drafts (no task_type) keep the existing AuthoringMode. */
function isV3Task(task: Task | null): boolean {
  const spec = taskSpecOf(task)
  return !!spec && spec.task_type !== undefined
}

function resolveMode(task: Task | null): ModalMode {
  if (task === null) return "authoring-v3-template"
  if (task.status === "draft") {
    // v3 two-phase-flow draft (task_type set) → AuthoringWorkspace; legacy
    // v2 draft (no task_type) → the existing SpecPanel-based AuthoringMode.
    return isV3Task(task) ? "authoring-v3-workspace" : "authoring"
  }
  if (task.status === "ready" || task.status === "running") {
    return isComposite(task) ? "composite" : "simple-execution"
  }
  // done / failed / aborted
  if (task.status === "done") return isComposite(task) ? "composite" : "done"
  return isComposite(task) ? "composite" : "terminal"
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿", ready: "待执行", running: "执行中",
  done: "已完成", failed: "失败", aborted: "已中止",
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-blue-500/15 text-blue-500",
  running: "bg-blue-500/15 text-blue-500",
  done: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-red-500/15 text-red-500",
  aborted: "bg-zinc-500/15 text-zinc-500",
}

// ── TaskModal ───────────────────────────────────────────────────────

export function TaskModal({ open, onOpenChange, task, onMutated, onDraftResolved }: TaskModalProps) {
  const mode = resolveMode(task)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Reset fullscreen when modal closes
  useEffect(() => {
    if (!open) setIsFullscreen(false)
  }, [open])

  return (
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
        <ModalHeader task={task} mode={mode} isFullscreen={isFullscreen} onToggleFullscreen={() => setIsFullscreen((f) => !f)} />
        <div className="flex-1 min-h-0 overflow-hidden">
          {mode === "authoring-v3-template" && (
            <TemplatePickerMode
              onDraftResolved={onDraftResolved ?? (() => {})}
              onMutated={onMutated}
              onClose={() => onOpenChange(false)}
            />
          )}
          {mode === "authoring-v3-workspace" && task && (
            <AuthoringWorkspace task={task} onMutated={onMutated} onClose={() => onOpenChange(false)} />
          )}
          {mode === "authoring" && (
            <AuthoringMode task={task} onMutated={onMutated} onDraftResolved={onDraftResolved} onClose={() => onOpenChange(false)} />
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
  )
}

function ModalHeader({ task, mode, isFullscreen, onToggleFullscreen }: {
  task: Task | null; mode: ModalMode; isFullscreen: boolean; onToggleFullscreen: () => void
}) {
  const title = task?.name ?? "新建任务"
  const status = task?.status ?? "draft"
  const subtitle =
    mode === "authoring"
      ? "Authoring · spec 左 / 对话 右"
      : mode === "composite"
        ? "复合任务"
        : mode === "done"
          ? "结果"
          : mode === "terminal"
            ? "终态"
            : "执行"
  return (
    <DialogHeader className="px-5 py-3 border-b border-border flex-row items-center justify-between space-y-0">
      <div className="min-w-0">
        <DialogTitle className="text-base truncate">{title}</DialogTitle>
        <DialogDescription className="text-xs">{subtitle}</DialogDescription>
      </div>
      <div className="flex items-center gap-2 shrink-0 mr-8">
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

// ── v3 Authoring: template picker → AuthoringWorkspace (two-phase) ────

/** Phase 1 of the v3 two-phase flow (ticket 09, D15). Renders the
 *  TemplatePicker; on 开始编写, runs the D15 create sequence:
 *    1. POST /api/clones/task-author/sessions  (session FIRST — autosave/
 *       spec-field/SSE all resolve via source_chat_session_id)
 *    2. POST /api/tasks {source_chat_session_id, task_type, skill_groups,
 *       preset{org,projects}} → creates the draft + home + materializes the
 *       plugin dir.
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

  const handleCreate = async (value: {
    task_type: "coding" | "generic"
    skill_groups: string[]
    preset: { org?: string; projects: string[] }
  }) => {
    setBusy(true)
    try {
      // D15 step 1: create the chat session FIRST.
      const session = await agentApi.createCloneSession(TASK_AUTHOR_CLONE)
      // D15 step 2: POST the task with the session id + v3 fields.
      const task = await createTask({
        org: value.preset.org ?? "default",
        source_chat_session_id: session.id,
        task_type: value.task_type,
        skill_groups: value.skill_groups,
        preset: value.preset,
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

function AuthoringMode({
  task, onMutated, onDraftResolved, onClose,
}: {
  task: Task | null
  onMutated: () => void
  onDraftResolved?: (task: Task) => void
  onClose: () => void
}) {
  const initialSessionId = task?.source_chat_session_id ?? null
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId)
  const pendingMessageRef = useRef<string | null>(null)

  // Sync activeSessionId when task's source_chat_session_id is set (draft resolved).
  useEffect(() => {
    if (task?.source_chat_session_id && task.source_chat_session_id !== activeSessionId) {
      setActiveSessionId(task.source_chat_session_id)
    }
  }, [task?.source_chat_session_id, activeSessionId])

  // API overrides: route through the task-author clone endpoints (05/07 pattern).
  const apiOverrides = useMemo(() => ({
    getSession: (id: string, q?: { limit?: number; cursor?: string }) =>
      agentApi.getCloneSession(TASK_AUTHOR_CLONE, id, q),
    chatStream: (id: string, msg: string) =>
      agentApi.cloneChatStream(TASK_AUTHOR_CLONE, id, msg),
    stopChat: (id: string) =>
      agentApi.stopCloneChat(TASK_AUTHOR_CLONE, id),
  }), [])

  const chat = useAgentChat(activeSessionId, { api: apiOverrides })

  const loadedSessionIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeSessionId) return
    if (loadedSessionIdsRef.current.has(activeSessionId)) return
    loadedSessionIdsRef.current.add(activeSessionId)
    if (pendingMessageRef.current) return // skip load for new sessions with pending msg
    chat.loadMessages()
  }, [activeSessionId, chat])

  const createSession = useCallback(async (): Promise<string | null> => {
    try {
      const session = await agentApi.createCloneSession(TASK_AUTHOR_CLONE)
      setActiveSessionId(session.id)
      return session.id
    } catch {
      return null
    }
  }, [])

  // New-task flow: after a turn, look up the draft the autosave seam (04)
  // created server-side (linked via source_chat_session_id). Best-effort —
  // the page's 10s polling + task_status SSE will also surface it.
  const resolveDraft = useCallback(async (sid: string) => {
    if (!sid || task) return
    try {
      const data = await listTasks({ status: "draft" })
      const draft = data.items
        .filter((t) => t.source_chat_session_id === sid && t.status === "draft")
        .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))[0]
      if (draft) onDraftResolved?.(draft)
    } catch {
      // refetch will happen via onMutated elsewhere
    }
  }, [task, onDraftResolved])

  const handleSend = useCallback((message: string) => {
    if (activeSessionId) {
      chat.sendMessage(message)
      void resolveDraft(activeSessionId)
    } else {
      pendingMessageRef.current = message
      void createSession()
    }
  }, [activeSessionId, chat, createSession, resolveDraft])

  useEffect(() => {
    if (activeSessionId && pendingMessageRef.current) {
      const msg = pendingMessageRef.current
      pendingMessageRef.current = null
      requestAnimationFrame(() => {
        chat.sendMessage(msg)
        void resolveDraft(activeSessionId)
      })
    }
  }, [activeSessionId, chat, resolveDraft])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 h-full min-h-0">
      <div className="flex flex-col min-h-0 border-r border-border overflow-y-auto">
        <SpecPanel task={task} onMutated={onMutated} />
      </div>
      <div className="flex flex-col min-h-0">
        <ChatArea
          messages={chat.messages}
          streaming={chat.streaming}
          streamContent={chat.streamContent}
          streamThinking={chat.streamThinking}
          isThinking={chat.isThinking}
          toolCalls={chat.toolCalls}
          pendingConfirm={chat.pendingConfirm}
          error={chat.error}
          statusMessage={chat.statusMessage}
          onSend={handleSend}
          onStop={chat.stopGenerate}
          onConfirm={chat.handleConfirm}
          hasSession={!!activeSessionId}
          currentCloneName={TASK_AUTHOR_CLONE}
          hideEmptyState
        />
      </div>
      <AuthoringFooter task={task} onEnqueue={onMutated} onClose={onClose} />
    </div>
  )
}

function AuthoringFooter({
  task, onEnqueue, onClose,
}: {
  task: Task | null
  onEnqueue: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const canEnqueue = !!task && task.status === "draft"

  const handleEnqueue = async () => {
    if (!task) return
    setBusy(true)
    try {
      // [入队] = draft→ready (confirm gate, v1 D13) + dispatch seam (server
      // creates the schedules envelope: simple=1 primary; composite=1 coordinator).
      await readyTask(task.id)
      toast.success("已入队，任务进入待执行列")
      onEnqueue()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "入队失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col-span-full flex items-center justify-end gap-2 border-t border-border px-5 py-3 bg-background">
      <span className="mr-auto text-xs text-muted-foreground">
        {task ? "确认 spec 后入队执行（[保存草稿] 在 spec 面板）" : "先与 task-author 对话生成 spec"}
      </span>
      <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
      <Button size="sm" onClick={handleEnqueue} disabled={!canEnqueue || busy} data-task-enqueue>
        {busy ? <Spinner className="size-4" /> : <Send className="size-4" />}
        入队
      </Button>
    </div>
  )
}

// ── Simple execution: single-ws status + abort ──────────────────────

function SimpleExecutionMode({ task, onMutated, onClose }: { task: Task; onMutated: () => void; onClose: () => void }) {
  const workflowRef = task.workflow_ref ?? "—"
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
    <div className="p-5 space-y-4" data-task-simple-execution>
      <div className="rounded-lg border border-border p-4 space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">workflow_ref</span><code className="text-xs">{workflowRef}</code></div>
        <div className="flex justify-between"><span className="text-muted-foreground">状态</span><span>{STATUS_LABEL[task.status] ?? task.status}</span></div>
        {task.completed_at ? (
          <div className="flex justify-between"><span className="text-muted-foreground">完成时间</span><span>{new Date(task.completed_at).toLocaleString()}</span></div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        实时进度经 SSE task_status 推送，看板卡与状态秒级同步。完整执行流程图见执行详情。
      </p>
      <div className="flex justify-end">
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

  // SG15: retarget child drill-down to the tasks domain.
  const handleChildClick = useCallback((scheduleId: string) => {
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

        {canAbort && (
          <div className="flex justify-end px-3 pb-4">
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
  const spec = taskSpecOf(task)
  return (
    <div className="p-5 space-y-3" data-task-done>
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm space-y-1">
        <div className="flex items-center gap-2 font-medium text-emerald-600"><CheckCircle2 className="size-4" /> 任务完成</div>
        {spec ? <p className="text-xs text-muted-foreground">目标: {spec.goal}</p> : null}
      </div>
      <p className="text-xs text-muted-foreground">综合报告与 PR 链接在结果产物就绪后展示。</p>
    </div>
  )
}

function TerminalMode({ task }: { task: Task }) {
  const failed = task.status === "failed"
  return (
    <div className="p-5 space-y-3" data-task-terminal>
      <div className={`rounded-lg border p-4 text-sm space-y-1 ${failed ? "border-red-500/30 bg-red-500/5" : "border-zinc-500/30 bg-zinc-500/5"}`}>
        <div className={`flex items-center gap-2 font-medium ${failed ? "text-red-500" : "text-zinc-500"}`}>
          {failed ? <AlertCircle className="size-4" /> : <Ban className="size-4" />}
          {failed ? "任务失败" : "任务已中止"}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{failed ? "失败为终态 (G2)，不会自动重派。可新建任务重试。" : "中止为终态，工作区已清理。"}</p>
    </div>
  )
}
