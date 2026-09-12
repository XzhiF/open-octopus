// packages/web-app/components/tasks/run-console/task-run-console.tsx
//
// TaskRunConsole —— 待执行/执行中/待验收/完成（含失败/中止）弹窗的统一壳
// （2026-09-12 执行弹窗改版·方案已拍板 tmp/exec-modal-proto）。
//
//   ┌ terminal 导航条（28px，与草稿窗同款壳）：红绿灯 + 标题 + 状态 pill +
//   │   语境 token（秒表/AI 账目/已等时长）+ 动作簇（触发/退回草稿/中止/⛶/关闭方糖）
//   ├ 左 rail：Phase 流水线 —— 唯一的状态呈现与导航（吸收 PhaseTimeline，
//   │   票 11 testid 钉点 phase-timeline/phase-row-*/phase-round-*/legacy 全保）
//   ├ 右 surface：选中 Phase 的控制台（PhaseSurface）/ 总战报（ReportSurface）
//   └ footer 状态条（24px）：创建/工作区/v4·N phases + SSE 心跳
//
// 数据纪律：derived（票 03 唯一真相）只读不重算；运行账目 = executions[] +
// llm-calls 聚合；盘上文件 = batch-tree。五区去重 —— 一个事实只出现一次。
// composite 不走本壳（保留旧 ModalHeader + CompositeMode）。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { Maximize2, Minimize2 } from "lucide-react"
import {
  PHASE_STATUS_UPDATE_EVENT, TASK_EXECUTION_EVENT, TASK_STATUS_EVENT,
  type Task,
} from "@octopus/shared"
import { getTask, reopenTask, abortTask, cancelTaskTrigger, type TaskDetail, type TaskExecutionBadge } from "@/lib/tasks-api"
import type { LLMCallAggregates } from "@/lib/types"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatCost, formatTokenCount } from "@/lib/format"
import { phaseBudgetMs } from "@/lib/task-board"
import { EditableTitle } from "../editable-title"
import { AcceptanceModal } from "../acceptance-modal"
import { TriggerDialog } from "../trigger-dialog"
import { useBatchTree } from "../authoring/use-batch-tree"
import {
  RUN_STATUS_LABEL, mergeAggregates, useRunsAggregates,
} from "../execution-summary"
import { PhaseSurface, ReportSurface, type RunCtx, type StreamEvent } from "./phase-surface"
import {
  PHASE_PILL, PHASE_STATUS_LABEL, TASK_PILL, TASK_STATUS_LABEL,
  clockShort, phaseTileTone, roundGlyph, roundOverBudget, roundTone,
} from "./phase-status"

export interface RunConsoleChrome {
  isFullscreen: boolean
  onToggleFullscreen: () => void
  /** 🎪 按住导航条空白拖窗（与草稿窗 chrome 同契约）。 */
  onHeaderPointerDown?: (e: React.PointerEvent) => void
}

interface TaskRunConsoleProps {
  task: Task
  onMutated: () => void
  onClose: () => void
  chrome?: RunConsoleChrome
}

const LIVE_RUN_STATUSES = new Set(["pending", "running", "paused", "pending_approval", "pending_resume"])
const ERROR_RUN_STATUSES = new Set(["failed", "aborted", "completed_with_failures"])
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "aborted"])

export function TaskRunConsole({ task, onMutated, onClose, chrome }: TaskRunConsoleProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [accOpen, setAccOpen] = useState(false)
  const [busy, setBusy] = useState<"abort" | "reopen" | "cancel" | null>(null)
  // 选中面：phase index | "report"；undefined = 未交互，跟随状态自动选。
  const [sel, setSel] = useState<number | "report" | undefined>(undefined)
  useEffect(() => { setSel(undefined) }, [task.id])

  const isLive =
    task.status === "ready" || task.status === "running" ||
    task.status === "awaiting_review" || task.status === "archiving"

  const refetch = useCallback(() => {
    getTask(task.id).then(setDetail).catch(() => { /* keep last snapshot */ })
  }, [task.id])
  useEffect(() => { refetch() }, [refetch])
  useEffect(() => {
    if (!isLive) return
    const id = setInterval(refetch, 5000)
    return () => clearInterval(id)
  }, [isLive, refetch])

  // ── SSE：状态即时重拉（与退役前 TaskRunDetailView 同四路）+ 活动流采集 ──
  const [events, setEvents] = useState<StreamEvent[]>([])
  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (e: MessageEvent): Record<string, unknown> | null => {
      try {
        const p = JSON.parse(e.data) as { task_id?: string }
        return p.task_id === task.id ? (p as Record<string, unknown>) : null
      } catch { return null }
    }
    const push = (glyph: string, tone: string, text: string) =>
      setEvents((prev) => [...prev.slice(-40), { at: new Date().toLocaleTimeString("zh-CN", { hour12: false }), glyph, tone, text }])
    const unStatus = subscribeSSE(url, TASK_STATUS_EVENT, (e) => {
      const p = mine(e); if (!p) return
      push("◆", "text-pop-cyan", `task → ${TASK_STATUS_LABEL[String(p.status)] ?? String(p.status)}`)
      refetch()
    })
    const unExec = subscribeSSE(url, TASK_EXECUTION_EVENT, (e) => {
      const p = mine(e); if (!p) return
      const tag = p.phase_index != null ? `P${p.phase_index}·R${p.round_index ?? 1}` : (p.subunit ? `子单元 ${p.subunit}` : "run")
      const st = String(p.status)
      const reason = ERROR_RUN_STATUSES.has(st) && p.reason ? ` — ${String(p.reason)}` : ""
      push(LIVE_RUN_STATUSES.has(st) ? "▶" : st === "completed" || st === "done" || st === "success" ? "✓" : "✗",
        LIVE_RUN_STATUSES.has(st) ? "text-pop-purple" : "text-pop-green",
        `${tag} ${RUN_STATUS_LABEL[st] ?? st}${reason}`)
      refetch()
    })
    const unPhase = subscribeSSE(url, PHASE_STATUS_UPDATE_EVENT, (e) => {
      const p = mine(e); if (!p) return
      push("■", "text-pop-amber", `P${p.phase_index ?? "?"} → ${PHASE_STATUS_LABEL[String(p.status)] ?? String(p.status)}`)
      refetch()
    })
    return () => { unStatus(); unExec(); unPhase() }
  }, [task.id, refetch])

  const tree = useBatchTree(task.id, { versionKey: detail?.version })
  // detail 每次重拉都是新对象 —— runs/phaseViews memo 化，下游 useMemo 的依赖才稳。
  const runs = useMemo(() => detail?.executions ?? [], [detail])
  const execIds = useMemo(() => runs.map((r) => r.id), [runs])
  const { aggMap, loaded: aggLoaded } = useRunsAggregates(execIds, isLive)
  const totalAgg = useMemo(() => mergeAggregates(Object.values(aggMap)), [aggMap])
  const runsById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs])

  // 秒表：live 且确有活轮时 1s 一跳（数据刷新仍归轮询/SSE）。
  const anyLiveRun = runs.some((r) => LIVE_RUN_STATUSES.has(r.status))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isLive || !anyLiveRun) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isLive, anyLiveRun])

  const derived = detail?.derived
  const phaseViews = useMemo(() => derived?.phaseViews ?? [], [derived])
  const isV4 = derived ? derived.isV4 : task.task_spec?.format === "v4"
  const specPhases = detail?.task_spec?.phases ?? task.task_spec?.phases ?? []
  const budgetMs = phaseBudgetMs()

  // 自动选中：待验收/执行中的那个 phase 优先，其次待发/首个；终态与 v3 → 战报。
  const autoView: number | "report" = useMemo(() => {
    if (!derived || !derived.isV4 || phaseViews.length === 0) return "report"
    if (TERMINAL_TASK_STATUSES.has(task.status)) return "report"
    const active =
      phaseViews.find((p) => p.status === "awaiting_review") ??
      phaseViews.find((p) => p.status === "running") ??
      phaseViews.find((p) => p.status === "pending") ??
      phaseViews[phaseViews.length - 1]
    return active?.index ?? "report"
  }, [derived, phaseViews, task.status])
  const view = sel ?? autoView

  const ctx: RunCtx = {
    task, detail, specPhases, phaseViews, tree, aggMap, totalAgg, runsById,
    now, isLive, events, refetch, onMutated,
    openAcceptance: () => setAccOpen(true),
    openTrigger: () => setTriggerOpen(true),
  }

  // ── 导航条动作 ─────────────────────────────────────────────────────
  const canAbort = task.status === "running" || task.status === "ready"
  const canReopen = task.status === "ready"
  const dueAt = task.next_fire_at
  const armedFuture = !!dueAt && new Date(dueAt).getTime() > Date.now()
  const waitingForSlot = task.execution?.status === "pending"
  const liveRun = runs.find((r) => LIVE_RUN_STATUSES.has(r.status)) ?? null
  const awaitingPv = phaseViews.find((p) => p.status === "awaiting_review") ?? null
  const awaitingRun = awaitingPv?.awaitingRound != null
    ? runsById.get(awaitingPv!.rounds.find((r) => r.roundIndex === awaitingPv!.awaitingRound)?.exec.id ?? "") ?? null
    : null
  const waitedMs = awaitingRun?.completed_at ? Math.max(0, now - Date.parse(awaitingRun.completed_at)) : null

  const handleAbort = async () => {
    setBusy("abort")
    try {
      await abortTask(task.id)
      toast.success("已中止任务，工作区将清理")
      onMutated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
    } finally { setBusy(null) }
  }
  const handleReopen = async () => {
    setBusy("reopen")
    try {
      await reopenTask(task.id)
      toast.success("已退回草稿 — 回到创作面板继续修改，改完可重新入队")
      onMutated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "退回草稿失败")
    } finally { setBusy(null) }
  }
  const handleCancelTrigger = async () => {
    setBusy("cancel")
    try {
      await cancelTaskTrigger(task.id)
      toast.success("已取消定时触发")
      onMutated(); refetch()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "取消失败")
    } finally { setBusy(null) }
  }

  const barBtn = "rounded border-[1.5px] border-pop-bg/30 px-1.5 py-px text-[9.5px] font-black text-pop-bg transition-colors hover:border-pop-yellow hover:text-pop-yellow"

  return (
    <div className="flex h-full min-h-0 flex-col" data-run-console={task.status}>
      {/* ── terminal 导航条 ──（与草稿窗同壳：28px 深色 mono） */}
      <div
        data-terminal-bar
        onPointerDown={chrome?.onHeaderPointerDown}
        title={chrome ? "按住空白处拖拽移动窗口" : undefined}
        className={
          "flex h-7 shrink-0 select-none items-center gap-2 overflow-hidden whitespace-nowrap border-b-[2.5px] border-pop-bd bg-pop-ink px-2.5 font-mono text-[11px] text-pop-bg " +
          (chrome ? "cursor-grab touch-none active:cursor-grabbing" : "")
        }
      >
        <span aria-hidden className="flex shrink-0 items-center gap-[5px]">
          <i className="block size-[9px] rounded-full border-[1.5px] border-black/30 bg-pop-pink" />
          <i className="block size-[9px] rounded-full border-[1.5px] border-black/30 bg-pop-yellow" />
          <i className="block size-[9px] rounded-full border-[1.5px] border-black/30 bg-pop-cyan" />
        </span>
        <span aria-hidden className="shrink-0 text-pop-bg/25">│</span>
        <EditableTitle task={task} onMutated={onMutated} variant="term" />
        <span aria-hidden className="shrink-0 text-pop-bg/25">│</span>
        <span
          data-task-modal-status={task.status}
          className={`shrink-0 rounded-full border-[1.5px] px-2 py-px text-[10px] font-black ${TASK_PILL[task.status] ?? "border-pop-bg/30 text-pop-bg/70"}`}
        >
          {task.status === "awaiting_review" && awaitingPv
            ? `◆ 待验收 · P${awaitingPv.index}`
            : `● ${TASK_STATUS_LABEL[task.status] ?? task.status}`}
        </span>
        {/* 语境 token：一条把「现在最该知道的数」说完 */}
        {task.status === "ready" && (armedFuture
          ? <span className="shrink-0 text-pop-bg/70">⏰ 已定时 <b className="text-pop-bg">{clockShort(dueAt)}</b> 触发</span>
          : waitingForSlot
            ? <span className="shrink-0 text-pop-amber">⏳ 已到点，等并发闸…</span>
            : <span className="shrink-0 text-pop-bg/70">⚡ 待触发 · {specPhases.length || phaseViews.length} phases</span>)}
        {task.status === "running" && liveRun && (
          <>
            <span className="shrink-0 text-pop-bg/70">⏱ <b className="text-pop-bg tabular-nums">{liveDur(liveRun, now)}</b>{liveRun.phase_index != null ? `（P${liveRun.phase_index}·R${liveRun.round_index ?? 1}）` : ""}</span>
            {totalAgg && totalAgg.totalCalls > 0 && (
              <span className="shrink-0 text-pop-bg/70" title="任务全部运行合计">↑<b className="text-pop-bg">{formatTokenCount(totalAgg.usage.inputTokens)}</b> ↓<b className="text-pop-bg">{formatTokenCount(totalAgg.usage.outputTokens)}</b> · <b className="text-pop-bg">{formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)}</b></span>
            )}
          </>
        )}
        {task.status === "awaiting_review" && waitedMs != null && (
          <span className="shrink-0 text-pop-bg/70">等你放行 · 已等 <b className="text-pop-amber">{shortDur(waitedMs)}</b></span>
        )}
        {task.status === "archiving" && <span className="shrink-0 text-pop-bg/70">🗄 归档编排中（全绿才 done）</span>}
        {(task.status === "done" || task.status === "failed" || task.status === "aborted") && task.completed_at && (
          <span className="shrink-0 text-pop-bg/70">{clockShort(task.completed_at)}{totalAgg && totalAgg.totalCalls > 0 ? ` · ${formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)}` : ""}</span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {canReopen && (
            <button onClick={() => void handleReopen()} disabled={busy !== null} data-task-reopen className={barBtn} title="退回草稿继续修改">
              ↺ 退回草稿
            </button>
          )}
          {task.status === "awaiting_review" && (
            <button onClick={() => setAccOpen(true)} data-acceptance-open-bar className={barBtn} title="三栏证据面（摘要/产物/动作）">
              🔍 证据面
            </button>
          )}
          {task.status === "ready" && !armedFuture && !waitingForSlot && (
            <button
              onClick={() => setTriggerOpen(true)}
              disabled={busy !== null}
              data-task-trigger
              className="flex shrink-0 items-center gap-1 rounded-[7px] border-[1.5px] border-pop-bd bg-pop-green px-2.5 py-1 text-[10px] font-black text-white shadow-[2px_2px_0_rgba(0,0,0,.4)] transition-colors pop-press hover:bg-pop-green/90"
            >
              ⚡ 触发
            </button>
          )}
          {task.status === "ready" && armedFuture && (
            <button onClick={() => void handleCancelTrigger()} disabled={busy !== null} data-task-trigger-cancel className="rounded border-[1.5px] border-pop-amber/60 px-1.5 py-px text-[9.5px] font-black text-pop-amber transition-colors hover:bg-pop-amber hover:text-pop-ink">
              ✕ 取消触发
            </button>
          )}
          {canAbort && (
            <button
              onClick={() => void handleAbort()}
              disabled={busy !== null}
              data-task-abort
              className="rounded border-[1.5px] border-pop-red/60 px-1.5 py-px text-[9.5px] font-black text-[#ff8a8f] transition-colors hover:bg-pop-red hover:text-white"
              title="中止任务（工作区将清理）"
            >
              {busy === "abort" ? <Spinner className="size-2.5" /> : "■ 中止"}
            </button>
          )}
          {chrome && (
            <button
              onClick={chrome.onToggleFullscreen}
              title={chrome.isFullscreen ? "退出全屏 (Esc)" : "全屏"}
              className="rounded border-[1.5px] border-transparent p-0.5 text-pop-bg/55 transition-colors hover:border-pop-bg/40 hover:text-pop-yellow"
            >
              {chrome.isFullscreen ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc 同效）"
            className="grid size-[19px] shrink-0 place-items-center rounded-[7px] border-[1.5px] border-pop-bd bg-pop-red text-[10px] font-black leading-none text-white shadow-[2px_2px_0_rgba(0,0,0,.4)] transition-colors pop-press hover:bg-pop-red/90"
          >
            <span aria-hidden>✕</span>
          </button>
        </span>
      </div>

      {/* ── 主体：rail + surface ── */}
      <div className="flex min-h-0 flex-1">
        <PipelineRail
          ctx={ctx} budgetMs={budgetMs} view={view} onSelect={setSel}
          isV4={isV4} aggLoaded={aggLoaded}
        />
        <div className="min-w-0 flex-1 overflow-y-auto bg-pop-bg p-3.5">
          {view === "report" || !derived
            ? <ReportSurface ctx={ctx} />
            : (() => {
              const pv = phaseViews.find((p) => p.index === view)
              return pv ? <PhaseSurface ctx={ctx} pv={pv} /> : <ReportSurface ctx={ctx} />
            })()}
        </div>
      </div>

      {/* ── footer 状态条 ── */}
      <div className="flex h-6 shrink-0 select-none items-center gap-3 border-t-[2.5px] border-pop-bd bg-pop-ink px-3 font-mono text-[10.5px] text-pop-bg/70">
        <span>创建 <b className="font-semibold text-pop-bg">{clockShort(task.created_at)}</b></span>
        <span aria-hidden className="text-pop-bg/25">·</span>
        <span>{isV4 ? `v4 · ${phaseViews.length || specPhases.length} phases` : "v3 legacy"}</span>
        {liveRun?.workspace_id && (
          <>
            <span aria-hidden className="text-pop-bg/25">·</span>
            <span title={`workspace ${liveRun.workspace_id}`}>工作区 <b className="font-semibold text-pop-bg">{liveRun.workspace_id.slice(0, 8)}</b></span>
          </>
        )}
        {TERMINAL_TASK_STATUSES.has(task.status) && (
          <>
            <span aria-hidden className="text-pop-bg/25">·</span>
            <span className="text-pop-bg/45">{task.status === "done" ? "工作区已归档" : "工作区已清理"}</span>
          </>
        )}
        {isLive ? (
          <span className="ml-auto flex items-center gap-1.5 text-pop-cyan">SSE<i className="block size-[7px] animate-pulse rounded-full bg-pop-cyan" /></span>
        ) : (
          <span className="ml-auto text-pop-bg/35">终态 · 已停轮询</span>
        )}
      </div>

      {/* 对话框宿主（单实例） */}
      <TriggerDialog open={triggerOpen} onOpenChange={setTriggerOpen} task={task} onTriggered={() => { onMutated(); refetch() }} />
      <AcceptanceModal task={task} open={accOpen} onOpenChange={setAccOpen} onMutated={() => { onMutated(); refetch() }} />
    </div>
  )
}

// ── 左 rail：Phase 流水线（唯一状态位）──────────────────────────────

function PipelineRail({ ctx, budgetMs, view, onSelect, isV4, aggLoaded }: {
  ctx: RunCtx; budgetMs: number; view: number | "report"; onSelect: (v: number | "report") => void; isV4: boolean; aggLoaded: boolean
}) {
  const { task, detail, phaseViews, now, totalAgg } = ctx
  const derived = detail?.derived
  const terminal = TERMINAL_TASK_STATUSES.has(task.status)
  const runs = detail?.executions ?? []
  const firstStart = runs.length ? Math.min(...runs.map((r) => r.started_at ? Date.parse(r.started_at) : Date.parse(r.created_at)).filter((n) => !Number.isNaN(n))) : NaN
  const wallMs = !Number.isNaN(firstStart) ? Math.max(0, (task.completed_at ? Date.parse(task.completed_at) : now) - firstStart) : null

  return (
    <div className="w-[230px] shrink-0 overflow-y-auto border-r-[2.5px] border-pop-bd bg-pop-paper px-2.5 py-2.5" data-testid="phase-timeline" data-run-rail>
      <div className="mb-2 flex items-center gap-1.5 px-0.5 font-mono text-[9.5px] font-black tracking-[.1em] text-pop-dim">
        PIPELINE <b className="text-[13px] text-pop-ink">{isV4 ? phaseViews.length : "1"}</b> {isV4 ? "PHASES" : "LEGACY"}
      </div>

      {terminal && isV4 && phaseViews.length > 0 && (
        <RailReportChip active={view === "report"} onClick={() => onSelect("report")} />
      )}

      {!derived ? (
        <p className="px-1 py-2 font-mono text-[10.5px] text-pop-dim">{task.task_spec?.format === "v4" ? "派生视图读取中…" : "旧服务无派生视图 —— 见右侧账本。"}</p>
      ) : !derived.isV4 ? (
        <button
          onClick={() => onSelect("report")}
          data-testid="phase-row-legacy"
          data-phase-status={derived.taskStatus}
          className={`flex w-full items-center gap-2 rounded-xl border-2 bg-pop-bg px-2 py-1.5 text-left shadow-pop-sm transition-transform ${view === "report" ? "border-[2.5px] border-pop-bd outline outline-[3px] outline-pop-yellow outline-offset-[1.5px]" : "border-pop-bd/70 hover:-translate-y-px"}`}
        >
          <span className="grid size-[18px] shrink-0 place-items-center rounded-[6px] border-2 border-pop-bd bg-pop-idle font-mono text-[9px] font-black text-pop-dim">V3</span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-black">v3 单阶段（legacy）</span>
            <span className="block font-mono text-[9.5px] text-pop-dim">按旧链路整体执行一次</span>
          </span>
        </button>
      ) : phaseViews.length === 0 ? (
        <p className="px-1 py-2 font-mono text-[10.5px] text-pop-dim" data-phase-empty>尚无 phase —— 拆分确认（对话出口）后出现。</p>
      ) : (
        phaseViews.map((p, i) => {
          const nextUp = task.status === "ready" && p.status === "pending" && !phaseViews.slice(0, i).some((q) => q.status === "pending")
          const selNode = view === p.index
          return (
            <div key={p.index}>
              {i > 0 && <div aria-hidden className="my-1 flex justify-center font-mono text-[8px] text-pop-bd/30">▼</div>}
              <button
                onClick={() => onSelect(p.index)}
                data-testid={`phase-row-${p.index}`}
                data-phase-status={p.status}
                className={`relative flex w-full items-start gap-2 rounded-xl border bg-pop-bg px-2 py-1.5 text-left shadow-pop-sm transition-transform hover:-translate-y-px ${
                  selNode ? "border-[2.5px] border-pop-bd outline outline-[3px] outline-pop-yellow outline-offset-[1.5px]" : "border-2 border-pop-bd/70"
                } ${p.status === "awaiting_review" ? "bg-pop-amber-soft" : ""}`}
              >
                <span className={`grid shrink-0 place-items-center rounded-[8px] border-2 border-pop-bd font-mono font-black ${selNode ? "size-[24px] text-[10.5px]" : "size-[18px] text-[9px]"} ${phaseTileTone(p.status, nextUp)}`}>
                  P{p.index}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] font-black leading-tight">{p.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    <span className={`rounded-full border-[1.5px] border-pop-bd px-1.5 py-px font-mono text-[8.5px] font-black ${PHASE_PILL[p.status] ?? "bg-pop-idle text-pop-dim"}`}>
                      {PHASE_STATUS_LABEL[p.status] ?? p.status}
                    </span>
                    {p.rounds.map((r) => {
                      const over = roundOverBudget(r, now, budgetMs)
                      const ran = (r.exec.workflow_ref ?? p.workflowRef).replace(/^built-in\//, "")
                      return (
                        <span
                          key={r.roundIndex}
                          data-testid={`phase-round-${p.index}-${r.roundIndex}`}
                          data-overbudget={String(over)}
                          title={over
                            ? `R${r.roundIndex}（${ran}）已跑超预算（${Math.round(budgetMs / 60000)} 分钟，advisory）`
                            : `R${r.roundIndex} · ${ran}${r.state}${r.decision ? ` · ${r.decision}` : ""}`}
                          className={`rounded-[6px] border-[1.5px] border-pop-bd px-1 py-px font-mono text-[8.5px] font-black tabular-nums ${roundTone(r)}`}
                        >
                          {`R${r.roundIndex} ${roundGlyph(r)}${over ? " ⏳" : ""}`}
                        </span>
                      )
                    })}
                  </span>
                </span>
              </button>
            </div>
          )
        })
      )}

      <div className="mt-3 space-y-0.5 border-t-2 border-dashed border-pop-bd/20 px-1 pt-2 font-mono text-[10px] text-pop-dim">
        <div>预算 <b className="text-pop-ink">{Math.round(budgetMs / 60000)}</b> 分/phase · 已用 <b className="text-pop-ink">{wallMs != null ? shortDur(wallMs) : "—"}</b></div>
        <div data-rail-ledger-line={totalAgg ? undefined : "pending"}>
          {totalAgg && totalAgg.totalCalls > 0
            ? <>账目 <b className="text-pop-ink">{formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)}</b> · <b className="text-pop-ink">{totalAgg.totalCalls}</b> 次调用</>
            : aggLoaded ? "账目 —（暂无已落库调用）" : "账目读取中…"}
        </div>
        {awaitingLine(ctx)}
      </div>
    </div>
  )
}

function RailReportChip({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-rail-report
      className={`mb-2 w-full rounded-lg border-2 px-2 py-1 text-left font-mono text-[10px] font-black transition-colors ${
        active ? "border-pop-bd bg-pop-yellow text-pop-ink shadow-pop-sm" : "border-pop-bd/40 bg-pop-bg text-pop-dim hover:border-pop-bd"
      }`}
    >
      ■ 任务战报
    </button>
  )
}

function awaitingLine(ctx: RunCtx) {
  const p = ctx.phaseViews.find((x) => x.status === "awaiting_review")
  if (!p) return null
  return <div className="font-black text-pop-amber" data-rail-awaiting>◆ P{p.index} 等你 →</div>
}

// ── 小工具（条内短时长：1h12m / 14m32s / 42s）───────────────────────

function liveDur(run: TaskExecutionBadge, now: number): string {
  const start = run.started_at ? Date.parse(run.started_at) : Date.parse(run.created_at)
  if (Number.isNaN(start)) return "—"
  return shortDur(Math.max(0, now - start))
}

function shortDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}
