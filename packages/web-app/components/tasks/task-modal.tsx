// packages/web-app/components/tasks/task-modal.tsx
//
// TaskModal — the unified task modal for the first-class `tasks` domain
// (v2-D1, SG14 — reads `Task`, NOT `SchedulerJob`). One modal, modes:
// authoring-template ([+新建] 模板页) / authoring-workspace (draft 对话创作) /
// simple-execution / composite / done / terminal. v4-only UI 改版后旧的
// SpecPanel-based AuthoringMode 与其 re-export 已删除；创作走
// AuthoringWorkspace（task-author 对话 + v4 产出面板）。
//
// Drill-down (票03, ADR-0021): a task's runs ARE executions rows, each carrying its
// own workspace_id, so every run card deep-links
// /workspaces/{workspace_id}?tab=detail&execId={execution.id}.

"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { Ban, AlertCircle, CheckCircle2, Workflow, ExternalLink, Maximize2, Minimize2, Trash2, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, SubunitSpec } from "@octopus/shared"
import { PROJECT_SYNC_EVENT, TASK_STATUS_EVENT, TASK_EXECUTION_EVENT } from "@octopus/shared"
import {
  getTask, abortTask, deleteTask, reopenTask,
  type TaskDetail, type TaskExecutionBadge, type TaskView,
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
import { TaskRunDetailView, RUN_STATUS_LABEL, RUN_ERROR_STATUSES, runErrorOf } from "./execution-summary"
import { createTask } from "@/lib/tasks-api"

// ── Types ───────────────────────────────────────────────────────────

interface TaskModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = new-task authoring ([+新建]). A draft task opens authoring resumed
   *  on its source_chat_session_id; non-draft opens execution/done/terminal. */
  task: TaskView | null
  /** Refresh the kanban after a mutation (ready / abort / draft edit). */
  onMutated: () => void
  /** Page adopts a draft the task-author clone just created (new-task flow). */
  onDraftResolved?: (task: TaskView) => void
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
  draft: "bg-pop-idle text-pop-dim",
  ready: "bg-pop-cyan-soft text-pop-cyan",
  running: "bg-pop-purple-soft text-pop-purple",
  // K3/US8: 待验收=琥珀（等人放行，非红死）；归档中=橙（票 08 编排中）。
  awaiting_review: "bg-pop-yellow-soft text-pop-amber",
  archiving: "bg-pop-amber-soft text-pop-amber",
  done: "bg-pop-green-soft text-pop-green",
  failed: "bg-pop-pink-soft text-pop-red",
  aborted: "bg-pop-idle text-pop-dim",
}

// ── TaskModal ───────────────────────────────────────────────────────

export function TaskModal({ open, onOpenChange, task, onMutated, onDraftResolved }: TaskModalProps) {
  const mode = resolveMode(task)
  // 模板选择页(直建第一屏)只是单列表单 → 用紧凑弹窗;工作台/执行视图才需要宽面。
  const isTemplate = mode === "authoring-template"
  const [isFullscreen, setIsFullscreen] = useState(false)
  // 🎪 弹窗尺寸(视口百分比):右下角把手可调,localStorage 记忆。
  const [modalSize, setModalSize] = useState<{ w: number; h: number }>(() => {
    const clamp = (v: number) => Math.min(97, Math.max(45, v))
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem("octopus:taskmodal:size")
        const p = raw ? JSON.parse(raw) as { w?: unknown; h?: unknown } : null
        if (p && Number.isFinite(p.w) && Number.isFinite(p.h)) {
          return { w: clamp(Number(p.w)), h: clamp(Number(p.h)) }
        }
      } catch { /* 损坏/无痕 → 默认 */ }
    }
    return { w: 88, h: 93 } // 默认更高（用户要求）
  })
  useEffect(() => {
    if (isFullscreen) return
    try { window.localStorage.setItem("octopus:taskmodal:size", JSON.stringify(modalSize)) } catch { /* ignore */ }
  }, [modalSize, isFullscreen])
  // 🎪 拖拽移动:按住标题栏空白拖动弹窗;窗口始终 clamp 在视口内(不可移出屏幕)。
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const clampCenter = (v: number, sizePx: number, fullPx: number) => {
    const lo = (sizePx - fullPx) / 2, hi = (fullPx - sizePx) / 2
    return lo > hi ? 0 : Math.min(hi, Math.max(lo, v))
  }
  const startHeaderDrag = useCallback((e: React.PointerEvent) => {
    if (isFullscreen) return
    const t = e.target as HTMLElement
    if (t.closest("button, input, textarea, select, a, [data-no-drag]")) return
    e.preventDefault()
    // 指针捕获:拖出浏览器窗口也不丢 move/up,松手必达(防"卡拖拽")。
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* noop */ }
    const sx = e.clientX - dragOffset.x, sy = e.clientY - dragOffset.y
    const W = (modalSize.w / 100) * window.innerWidth, H = (modalSize.h / 100) * window.innerHeight
    document.body.style.cursor = "grabbing"
    document.body.style.userSelect = "none"
    const onMove = (ev: PointerEvent) => {
      setDragOffset({
        x: clampCenter(ev.clientX - sx, W, window.innerWidth),
        y: clampCenter(ev.clientY - sy, H, window.innerHeight),
      })
    }
    const onUp = () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
  }, [isFullscreen, dragOffset, modalSize])
  // 🎪 边/角缩放:对边锚定(被拖的边跟手),尺寸与位置都 clamp 在视口内 ——
  // 任何方向都拖不出屏幕。模板页/全屏不给把手。
  type DialogEdge = { t?: boolean; b?: boolean; l?: boolean; r?: boolean }
  const startDialogResize = useCallback((e: React.PointerEvent, edge: DialogEdge) => {
    e.preventDefault()
    e.stopPropagation()
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* noop */ }
    const vw = window.innerWidth, vh = window.innerHeight
    const sx = e.clientX, sy = e.clientY
    const sw = (modalSize.w / 100) * vw, sh = (modalSize.h / 100) * vh
    const ox = dragOffset.x, oy = dragOffset.y
    const minW = vw * 0.3, minH = vh * 0.35
    document.body.style.cursor = "nwse-resize"
    document.body.style.userSelect = "none"
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      let W = sw, H = sh, X = ox, Y = oy
      if (edge.r) { W = sw + dx; X = ox + dx / 2 }
      else if (edge.l) { W = sw - dx; X = ox + dx / 2 }
      if (edge.b) { H = sh + dy; Y = oy + dy / 2 }
      else if (edge.t) { H = sh - dy; Y = oy + dy / 2 }
      W = Math.min(vw - 8, Math.max(minW, W))
      H = Math.min(vh - 8, Math.max(minH, H))
      setModalSize({ w: (W / vw) * 100, h: (H / vh) * 100 })
      setDragOffset({ x: clampCenter(X, W, vw), y: clampCenter(Y, H, vh) })
    }
    const onUp = () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
  }, [modalSize, dragOffset])
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // Reset fullscreen & drag position when modal closes
  useEffect(() => {
    if (!open) { setIsFullscreen(false); setDragOffset({ x: 0, y: 0 }) }
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
              : isTemplate
                ? "sm:max-w-[680px] w-[92vw] max-h-[84vh] h-[80vh] p-0 gap-0 flex flex-col"
                : "max-h-[97vh] p-0 gap-0 flex flex-col"
          }
          style={
            isFullscreen || isTemplate
              ? undefined
              : {
                width: `${modalSize.w}vw`,
                maxWidth: "97vw",
                height: `${modalSize.h}vh`,
                // v4 的 translate-x-[-50%] 是独立 `translate` 属性,会和本行
                // transform 叠加(双重居中)→ 必须显式清零,居中只走 transform。
                translate: "0px 0px",
                // 覆盖基类的 translate-[-50%] 居中定位,叠加拖拽偏移
                transform: `translate(calc(-50% + ${dragOffset.x}px), calc(-50% + ${dragOffset.y}px))`,
              }
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
          {/* draft 工作台不再渲染 ModalHeader（2026-09-12 改版）：AuthoringWorkspace
              自带的 terminal 导航条就是标题栏（拖窗/全屏/废弃经 chrome 传入）。 */}
          {mode === "authoring-workspace" && (
            // Radix a11y：草稿模式下可见标题在 terminal 导航条里（EditableTitle
            // term 变体，不挂 DialogTitle），这里补一个 sr-only 标题兜底。
            <DialogTitle className="sr-only">{task?.name ?? "任务草稿"}</DialogTitle>
          )}
          {mode !== "authoring-workspace" && (
            <ModalHeader
              task={task}
              mode={mode}
              isFullscreen={isFullscreen}
              onToggleFullscreen={() => setIsFullscreen((f) => !f)}
              onDeleteDraft={() => setDeleteConfirmOpen(true)}
              onMutated={onMutated}
              onHeaderPointerDown={startHeaderDrag}
            />
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            {mode === "authoring-template" && (
              <TemplatePickerMode
                onDraftResolved={onDraftResolved ?? (() => {})}
                onMutated={onMutated}
                onClose={() => onOpenChange(false)}
              />
            )}
            {mode === "authoring-workspace" && task && (
              <AuthoringWorkspace
                task={task}
                onMutated={onMutated}
                onClose={() => onOpenChange(false)}
                chrome={{
                  isFullscreen,
                  onToggleFullscreen: () => setIsFullscreen((f) => !f),
                  onDeleteDraft: () => setDeleteConfirmOpen(true),
                  onHeaderPointerDown: startHeaderDrag,
                }}
              />
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

          {/* 🎪 八向缩放手柄:四边 + 四角(对边锚定,拖不出视口);
              SE 角保留唯一可见的斜纹把手。模板页固定尺寸不给把手。 */}
          {!isFullscreen && !isTemplate && (
            <>
              <div data-modal-resize="n" title="拖拽调整高度"
                onPointerDown={(e) => startDialogResize(e, { t: true })}
                className="absolute inset-x-8 top-0 z-30 h-1.5 touch-none cursor-ns-resize hover:bg-pop-pink/40" />
              <div data-modal-resize="s" title="拖拽调整高度"
                onPointerDown={(e) => startDialogResize(e, { b: true })}
                className="absolute inset-x-8 bottom-0 z-30 h-1.5 touch-none cursor-ns-resize hover:bg-pop-pink/40" />
              <div data-modal-resize="w" title="拖拽调整宽度"
                onPointerDown={(e) => startDialogResize(e, { l: true })}
                className="absolute inset-y-8 left-0 z-30 w-1.5 touch-none cursor-ew-resize hover:bg-pop-pink/40" />
              <div data-modal-resize="e" title="拖拽调整宽度"
                onPointerDown={(e) => startDialogResize(e, { r: true })}
                className="absolute inset-y-8 right-0 z-30 w-1.5 touch-none cursor-ew-resize hover:bg-pop-pink/40" />
              <div data-modal-resize="nw" title="拖拽调整宽高"
                onPointerDown={(e) => startDialogResize(e, { t: true, l: true })}
                className="absolute left-0 top-0 z-40 size-4 touch-none cursor-nwse-resize" />
              <div data-modal-resize="ne" title="拖拽调整宽高"
                onPointerDown={(e) => startDialogResize(e, { t: true, r: true })}
                className="absolute right-0 top-0 z-40 size-4 touch-none cursor-nesw-resize" />
              <div data-modal-resize="sw" title="拖拽调整宽高"
                onPointerDown={(e) => startDialogResize(e, { b: true, l: true })}
                className="absolute bottom-0 left-0 z-40 size-4 touch-none cursor-nesw-resize" />
              <div data-modal-resize="se" title="拖拽调整宽高" aria-label="调整弹窗宽高"
                onPointerDown={(e) => startDialogResize(e, { b: true, r: true })}
                className="absolute bottom-0.5 right-0.5 z-40 size-5 touch-none cursor-nwse-resize text-pop-bd/60 transition-colors hover:text-pop-pink"
              >
                <svg viewBox="0 0 20 20" className="size-full" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 18.5 18.5 5" />
                  <path d="M10.5 18.5 18.5 10.5" />
                  <path d="M15.5 18.5 18.5 15.5" />
                </svg>
              </div>
            </>
          )}
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
              className="bg-pop-red hover:bg-pop-red/90"
            >
              {deleteBusy ? "删除中…" : "确认废弃"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ModalHeader({ task, mode, isFullscreen, onToggleFullscreen, onDeleteDraft, onMutated, onHeaderPointerDown }: {
  task: Task | null; mode: ModalMode; isFullscreen: boolean; onToggleFullscreen: () => void; onDeleteDraft: () => void; onMutated: () => void;
  /** 🎪 按住标题栏空白拖窗;interactive 元素由守卫排除。 */
  onHeaderPointerDown?: (e: React.PointerEvent) => void
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
    <DialogHeader
      onPointerDown={onHeaderPointerDown}
      title="按住空白处拖拽移动窗口"
      className="px-5 py-3 border-b-2 border-pop-bd bg-pop-paper flex-row items-center justify-between space-y-0 touch-none cursor-grab active:cursor-grabbing"
    >
      <div className="min-w-0">
        <EditableTitle task={task} onMutated={onMutated} />
        <DialogDescription className="text-xs">{subtitle}</DialogDescription>
      </div>
      <div className="flex items-center gap-2 shrink-0 mr-8">
        {isDraft && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-pop-red hover:text-pop-red/80 hover:bg-pop-pink-soft"
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
        <Badge variant="secondary" className={`rounded-full border-2 border-pop-bd text-[10px] font-black shadow-pop-sm ${STATUS_TONE[status] ?? ""}`} data-task-modal-status={status}>
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
  onDraftResolved: (task: TaskView) => void
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

function SimpleExecutionMode({ task, onMutated, onClose }: { task: TaskView; onMutated: () => void; onClose: () => void }) {
  const [aborting, setAborting] = useState(false)
  const [reopening, setReopening] = useState(false)
  // server abortTask accepts ready/running — the button used to grey out on
  // ready (canAbort=running only), strapping a not-yet-started task shut with
  // no exit at all. Same source of truth as the server guard now.
  const canAbort = task.status === "running" || task.status === "ready"
  const canReopen = task.status === "ready"

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

  const handleReopen = async () => {
    setReopening(true)
    try {
      await reopenTask(task.id)
      toast.success("已退回草稿 — 回到创作面板继续修改，改完可重新入队")
      onMutated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "退回草稿失败")
    } finally {
      setReopening(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-task-simple-execution>
      <div className="flex-1 min-h-0">
        <TaskRunDetailView task={task} />
      </div>
      <div className="shrink-0 flex items-center justify-end gap-2 border-t border-border px-5 py-3 bg-background">
        {canReopen && (
          <Button variant="ghost" size="sm" onClick={handleReopen} disabled={reopening} data-task-reopen>
            {reopening ? <Spinner className="size-4" /> : <Undo2 className="size-4" />}
            退回草稿
          </Button>
        )}
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

/** Project the task's run history onto the child axis composite-dag/composite-status
 *  consume. 票05 (ADR-0021): the fan-out arms ARE `root.children[]` (detail/history
 *  loads them; the board badge does not), and each arm's label is the badge's own
 *  `name` — dispatchChildRun wrote subunit.name onto the row, replacing the retired
 *  `schedules.origin_role='subunit'` labelling and the workflow_ref→spec match (kept
 *  only as fallback for name-less rows). A root whose `children` is undefined never
 *  contributes arms: undefined = the read model did not load the fan-out, which is
 *  NOT the same fact as [] (loaded, nothing dispatched yet) — either way the axis
 *  stays empty, the UI must not claim 「无子单元」. */
function executionsToDagChildren(
  execs: TaskExecutionBadge[],
  spec: TaskSpec | null,
): { run_id: string; name: string; status: string; workflow_ref: string; subunit_name: string }[] {
  const subunitByRef = new Map((spec?.subunits ?? []).map(s => [s.workflow_ref, s.name]))
  const toChild = (e: TaskExecutionBadge) => {
    const specMatch = subunitByRef.get(e.workflow_ref)
    const label = e.name || specMatch || e.workflow_ref
    return {
      run_id: e.id,
      name: label,
      status: e.status,
      workflow_ref: e.workflow_ref,
      subunit_name: e.name ?? specMatch ?? "",
    }
  }
  const arms: TaskExecutionBadge[] = []
  for (const root of execs) arms.push(...(root.children ?? []))
  return arms.map(toChild)
}

const RUN_DONE = new Set(["done", "completed", "success"])

/** A run row's label. 票05: an execution badge carries `name` (simple run name /
 *  composite arm = the subunit name written at dispatch), so the row names itself;
 *  the spec workflow_ref match and the raw ref are fallbacks for name-less rows. */
function runLabelOf(exec: TaskExecutionBadge, spec: TaskSpec | null): string {
  if (exec.name) return exec.name
  const subunit = (spec?.subunits ?? []).find(s => s.workflow_ref === exec.workflow_ref)?.name
  return subunit ?? exec.workflow_ref
}

function integrationStatusOf(parent: string, children: { status: string }[]): string {
  if (parent === "done" || parent === "failed" || parent === "aborted") return parent
  const allChildrenDone = children.length > 0 && children.every((c) => RUN_DONE.has(c.status))
  return allChildrenDone ? "running" : "pending"
}

export function CompositeMode({
  task, onMutated, onClose,
}: {
  task: TaskView
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

  // Real-time SSE on /api/tasks/events. 票03 (ADR-0021) leaves TWO event types on the
  // `taskpool` channel that this drill-down cares about (both forwarded by the route):
  //  - task_status    {task_id, status}                          — the task row's own
  //                    transitions, written by the built-in task-lifecycle job (the
  //                    ScheduleStatusListener mirror + its schedule_id/origin_type keys
  //                    went away with the envelope row).
  //  - task_execution {task_id, execution_id, status, phase_index?, round_index?,
  //                    subunit?, parent_id?, reason?}            — per-run transitions
  //                    (arm→pending, launch→running, terminal, 子单元派发). These are
  //                    the frequent signals; without this subscription the cards only
  //                    refresh on the slower parent event. The schedule_status events
  //                    that used to carry them now belong to job definitions only, so
  //                    subscribing to them here would filter every real run out.
  useEffect(() => {
    if (!task.id) return
    const eventsUrl = `${getServerUrl()}/api/tasks/events`
    const parentLabel = "父任务"

    /** A run row's label for the events panel (see runLabelOf); arms live inside
     *  their root's `children`, so the lookup descends one level (票05). */
    const findRun = (executionId: string): TaskExecutionBadge | null => {
      const d = detailRef.current
      if (!d) return null
      for (const e of d.executions ?? []) {
        if (e.id === executionId) return e
        const arm = (e.children ?? []).find((c) => c.id === executionId)
        if (arm) return arm
      }
      return null
    }
    const runLabel = (executionId: string): string => {
      const exec = findRun(executionId)
      return exec ? runLabelOf(exec, detailRef.current?.task_spec ?? null) : executionId.slice(0, 8)
    }

    const pushEvent = (runId: string, status: string, label?: string, reason?: string) => {
      setEvents((prev) => [
        ...prev,
        {
          run_id: runId,
          status,
          label: label ?? (runId === task.id ? parentLabel : runLabel(runId)),
          // 票05 契约 §新事实-2: reason 只在失败/回收路径出现，且红状态才露出
          // （绿行永不显示遗留字段 —— 与 runErrorOf 同一判据）。
          reason: RUN_ERROR_STATUSES.has(status) ? reason : undefined,
          at: new Date().toISOString(),
        },
      ])
    }

    const onTaskStatus = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { task_id: string; status: string }
        if (payload.task_id !== task.id) return
        pushEvent(task.id, payload.status, parentLabel)
        void fetchDetail(task.id)
      } catch {
        // Malformed event payload — ignore.
      }
    }

    const onTaskExecution = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as {
          task_id: string; execution_id: string; status: string; subunit?: string; reason?: string
        }
        // task_execution fires for every task on the shared taskpool channel — filter
        // to this task so an unrelated run doesn't trigger a spurious refetch. The arm
        // name comes from the payload (`subunit`) or the row (`children[].name`, 票05);
        // `reason` is the failure/reap one-liner (see pushEvent's status gate).
        if (payload.task_id !== task.id) return
        pushEvent(payload.execution_id, payload.status, payload.subunit, payload.reason)
        void fetchDetail(task.id)
      } catch {
        // Malformed event payload — ignore.
      }
    }

    // repo-sync 反馈 (2026-09-08, 特性A)：创建 draft 后项目主 clone 异步对齐
    // origin 最新 —— syncing 挂一条按 task 去重的 loading，ok/failed 原地收掉
    // （同 toast id 替换，不会堆叠）。failed 不静默：代码可能过期必须可见。
    const onProjectSync = (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) as {
          task_id: string; project: string; status: "syncing" | "ok" | "failed"
          branch?: string; commit?: string; error?: string
        }
        if (p.task_id !== task.id) return
        const toastId = `repo-sync-${task.id}`
        if (p.status === "syncing") {
          toast.loading(`仓库同步中：${p.project} → origin 最新`, { id: toastId })
        } else if (p.status === "ok") {
          toast.success(`仓库已同步：${p.project} ${p.branch}@${p.commit}`, { id: toastId })
        } else {
          toast.error(`仓库同步失败：${p.project} — ${p.error ?? "未知错误"}（代码可能过期）`, { id: toastId })
        }
      } catch {
        // Malformed event payload — ignore.
      }
    }

    // task_trigger_failed deliberately has NO subscription here: the kanban is its
    // one outlet (see app/tasks/page.tsx). This drill-down's cursor state is
    // already carried by task_status (the status really moves back to ready there).
    const unsubTaskStatus = subscribeSSE(eventsUrl, TASK_STATUS_EVENT, onTaskStatus)
    const unsubTaskExecution = subscribeSSE(eventsUrl, TASK_EXECUTION_EVENT, onTaskExecution)
    const unsubProjectSync = subscribeSSE(eventsUrl, PROJECT_SYNC_EVENT, onProjectSync)
    return () => {
      unsubTaskStatus()
      unsubTaskExecution()
      unsubProjectSync()
    }
  }, [task.id, fetchDetail])

  const runs = detail?.executions ?? []
  const dagChildren = executionsToDagChildren(runs, taskSpecOf(task))
  const dag = deriveDag(taskSpecOf(task))
  const parentStatus = detail?.status ?? task.status
  const aggregate = computeAggregateStatus(dagChildren, parentStatus)
  const integrationStatus = integrationStatusOf(parentStatus, dagChildren)
  const canAbort = parentStatus === "running"

  // 票03: a run row IS the execution and carries its own workspace_id, so the drill-down
  // is always the workspace 执行详情 deep link — the /tasks/:id/children/:sid route this
  // used to fall back to never existed (404) and nothing needs it any more.
  // 票05: the clicked id may be a fan-out arm — it lives inside its root's `children`
  // and links to its OWN workspace row, same as a root does.
  const handleRunClick = useCallback((executionId: string) => {
    const d = detailRef.current
    if (!d) return
    for (const e of d.executions ?? []) {
      if (e.id === executionId && e.workspace_id) {
        router.push(`/workspaces/${e.workspace_id}?tab=detail&execId=${e.id}`)
        return
      }
      const arm = (e.children ?? []).find((c) => c.id === executionId)
      if (arm?.workspace_id) {
        router.push(`/workspaces/${arm.workspace_id}?tab=detail&execId=${arm.id}`)
        return
      }
    }
  }, [router])

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
          <span className="text-xs text-muted-foreground">{runs.length} 条运行</span>
        </div>

        {dag.nodes.length > 0 ? (
          <div className="px-2 py-3 border-b border-border">
            <CompositeDag
              dag={dag}
              children={dagChildren}
              integrationStatus={integrationStatus}
              onChildClick={(name) => {
                const child = dagChildren.find((c) => c.subunit_name === name)
                if (child) handleRunClick(child.run_id)
              }}
            />
          </div>
        ) : (
          <div className="px-4 py-6 text-xs text-muted-foreground">等待 composition DAG…</div>
        )}

        <div className="p-3 space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">执行记录</h3>
          {runs.map((r) => (
            <div key={r.id} className="space-y-1">
              <button
                data-testid={`composite-child-${r.id}`}
                onClick={() => handleRunClick(r.id)}
                className="w-full text-left rounded-md border border-border bg-card p-2.5 hover:border-primary/40 hover:shadow-sm transition-all flex items-center gap-2"
              >
                <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[r.status] ?? "bg-muted-foreground"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{runLabelOf(r, detail?.task_spec ?? null)}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <code className="text-[10px]">{r.workflow_ref}</code>
                    <span>·</span>
                    <span>{RUN_STATUS_LABEL[r.status] ?? r.status}</span>
                    {r.phase_index != null && (
                      <span className="text-[10px] px-1 rounded bg-muted">
                        P{r.phase_index}·R{r.round_index ?? 1}
                      </span>
                    )}
                  </div>
                  {runErrorOf(r) && (
                    <div className="text-xs text-pop-red break-words" data-run-error={r.id}>{runErrorOf(r)}</div>
                  )}
                </div>
                <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
              </button>
              {/* 票05: composite fan-out arms under their root — labelled by the badge's
                  own `name` (the dispatch-time subunit name). `children === undefined`
                  (read model did not load the fan-out) and `[]` both render nothing:
                  「没加载」不是「没有」, never a 「无子单元」 claim. */}
              {(r.children?.length ?? 0) > 0 && (
                <div className="pl-4 space-y-1 border-l border-border/60" data-testid={`composite-arms-${r.id}`}>
                  {(r.children ?? []).map((arm) => {
                    const armError = runErrorOf(arm)
                    return (
                      <button
                        key={arm.id}
                        data-testid={`composite-arm-${arm.id}`}
                        onClick={() => handleRunClick(arm.id)}
                        className="w-full text-left rounded-md border border-border bg-card/50 px-2.5 py-1.5 hover:border-primary/40 transition-all flex items-center gap-2 text-xs"
                      >
                        <span className={`size-1.5 rounded-full shrink-0 ${STATUS_DOT_COLOR[arm.status] ?? "bg-muted-foreground"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{arm.name || arm.workflow_ref || `执行 ${arm.id.slice(0, 8)}`}</div>
                          {armError && <div className="text-pop-red break-words" data-run-error={arm.id}>{armError}</div>}
                        </div>
                        <span className="text-muted-foreground shrink-0">{RUN_STATUS_LABEL[arm.status] ?? arm.status}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
          {runs.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">任务尚未派发执行。</p>
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
  // executions 词表 (票03: 运行行状态)
  pending: "bg-pop-amber",
  completed: "bg-pop-green",
  completed_with_failures: "bg-pop-amber",
  cancelled: "bg-pop-dim",
  rejected: "bg-pop-dim",
  // 旧 schedule 词表（v3 历史行只读）
  queued: "bg-pop-cyan",
  claimed: "bg-pop-amber",
  running: "bg-pop-cyan animate-pulse",
  done: "bg-pop-green",
  failed: "bg-pop-red",
  aborted: "bg-pop-dim",
}

function DoneMode({ task }: { task: Task }) {
  return (
    <div className="flex flex-col h-full min-h-0" data-task-done>
      <div className="shrink-0 flex items-center gap-2 border-b border-pop-green/30 bg-pop-green-soft px-5 py-2.5 text-sm text-pop-green">
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
      <div className={`shrink-0 flex items-center gap-2 border-b px-5 py-2.5 text-sm ${failed ? "border-pop-red/30 bg-pop-pink-soft text-pop-red" : "border-pop-bd/30 bg-pop-idle text-pop-dim"}`}>
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
