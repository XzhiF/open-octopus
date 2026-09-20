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

import { useCallback, useEffect, useMemo, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { Maximize2, Minimize2 } from "lucide-react"
import {
  PHASE_STATUS_UPDATE_EVENT, TASK_EXECUTION_EVENT, TASK_STATUS_EVENT,
  type Task,
} from "@octopus/shared"
import { getTask, reopenTask, abortTask, cancelTaskTrigger, pauseTask, resumeTask, duplicateTask, type TaskDetail, type TaskExecutionBadge } from "@/lib/tasks-api"
import { fetchAgentEvents } from "@/lib/api-client"
import type { LLMCallAggregates } from "@/lib/types"
import { subscribeSSE, subscribeSSEStatus } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatCost } from "@/lib/format"
import { effectiveStatusOf, phaseBudgetMs } from "@/lib/task-board"
import { EditableTitle } from "../editable-title"
import { AcceptanceSurface } from "../acceptance/acceptance-surface"
import { TriggerDialog } from "../trigger-dialog"
import { useBatchTree } from "../authoring/use-batch-tree"
import {
  RUN_STATUS_LABEL, mergeAggregates, useRunsAggregates, AggInline, TaskAiUsageCard, execLabel,
} from "../execution-summary"
import { PhaseSurface, ReportSurface, type RunCtx, type StreamEvent } from "./phase-surface"
import { FoldMasterBar, FoldMasterChip, FoldProvider } from "../fold-context"
import { buildSignals, type SignalLine } from "./signal-build"
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
  /** 看板「验收」按钮直开时：落地即选中「验货台」tab。 */
  startOnAcceptance?: boolean
}

const LIVE_RUN_STATUSES = new Set(["pending", "running", "paused", "pending_approval", "pending_resume"])
const ERROR_RUN_STATUSES = new Set(["failed", "aborted", "completed_with_failures"])
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "aborted"])

export function TaskRunConsole({ task, onMutated, onClose, chrome, startOnAcceptance }: TaskRunConsoleProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [triggerOpen, setTriggerOpen] = useState(false)
  // 验货台 = 本控制台的 tab（2026-09-16 改版：原三栏弹窗 AcceptanceModal 收编
  // 内嵌，父窗自带拖拽/缩放/全屏；打回回显留在 tab 里，不随派生态变化弹出）。
  const [surfaceTab, setSurfaceTab] = useState<"console" | "accept">("console")
  // keep-mounted 挂载闸（2026-09-20）：点过验货台或出现待验收轮后**常挂载**，
  // tab 切换只切 hidden —— 三元卸载会把在飞的复检会话打回服务端尾 200 行、
  // gate/编辑草稿归零、重拉 5-6 个请求（「切走再回来失忆」）。换任务时复位。
  const [acceptMounted, setAcceptMounted] = useState(!!startOnAcceptance)
  const [busy, setBusy] = useState<"abort" | "reopen" | "cancel" | "pause" | "resume" | "duplicate" | null>(null)
  // 选中面：phase index | "report"；undefined = 未交互，跟随状态自动选。
  const [sel, setSel] = useState<number | "report" | undefined>(undefined)
  useEffect(() => {
    setSel(undefined)
    setSurfaceTab(startOnAcceptance ? "accept" : "console")
    setAcceptMounted(!!startOnAcceptance)
  }, [task.id, startOnAcceptance])

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

  // SSE 实况（2026-09-20）：footer 的 SSE● 旧版只看「任务活着」常亮脉冲，连接断了
  // 照样亮 —— 现接 sse-manager 的真实连接态（同 url 全页共享一条连接）。
  const [sseLive, setSseLive] = useState(true)
  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    return subscribeSSEStatus(url, (s) => setSseLive(s.connected))
  }, [])

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

  // 显示态 = 派生态（v4）/ 持久态（v3）。暂停是**派生**的：绑定执行落
  // executions.status='paused'，持久 task 行仍是 'running' —— 整条 chrome 若直接读
  // task.status，控制台会在暂停时继续自称「执行中」并照常渲染秒表/中止。
  // 优先级单源复用看板的 effectiveStatusOf（含 draft/aborted 例外），不在这里重写。
  const derivedStatus = effectiveStatusOf(task, derived)

  // 自动选中：待验收/执行中/已暂停的那个 phase 优先，其次待发/首个；终态与 v3 → 战报。
  const autoView: number | "report" = useMemo(() => {
    if (!derived || !derived.isV4 || phaseViews.length === 0) return "report"
    if (TERMINAL_TASK_STATUSES.has(derivedStatus)) return "report"
    const active =
      phaseViews.find((p) => p.status === "awaiting_review") ??
      phaseViews.find((p) => p.status === "running") ??
      // 暂停的 phase 必须在这条链里：多 phase 任务暂停在 P1 时，漏掉它就会兜底
      // 跳到**最后一个** phase 的面板 —— 静默错位。
      phaseViews.find((p) => p.status === "paused") ??
      phaseViews.find((p) => p.status === "pending") ??
      phaseViews[phaseViews.length - 1]
    return active?.index ?? "report"
  }, [derived, phaseViews, derivedStatus])
  const view = sel ?? autoView

  // ── 大事报信号（2026-09-20 定稿：没事不显示）─────────────────────────
  // 动线复盘被否：全绿履历没有一行需要用户决策。现只榨四类信号
  // （✗挂过自愈 / ♻修复轮 / ▷在跑长命令 / 📦产出），纯函数 buildSignals
  // 真格式单测钉死。活轮在跑时每 5s 重拉尾部；权威仍是 GET /:id derived。切轮重锚。
  const replayTarget = useMemo(() => {
    const runs = detail?.executions ?? []
    if (runs.length === 0) return null
    if (view !== "report") {
      const pv = phaseViews.find((p) => p.index === view)
      const last = pv?.rounds[pv.rounds.length - 1]
      const hit = last ? runs.find((r) => r.id === last.exec.id) : null
      if (hit) return hit
    }
    return runs[runs.length - 1] ?? null
  }, [detail, view, phaseViews])

  const [signals, setSignals] = useState<SignalLine[]>([])
  const targetId = replayTarget?.id ?? null
  const targetWs = replayTarget?.workspace_id ?? null
  const targetLive = !!replayTarget && LIVE_RUN_STATUSES.has(replayTarget.status)
  useEffect(() => {
    if (!targetId || !targetWs) return
    let cancelled = false
    const pull = () => {
      fetchAgentEvents(targetWs, targetId)
        .then((res) => { if (!cancelled) setSignals(buildSignals(res.events, Date.now(), { live: targetLive && isLive, loopIterations: res.loopIterations })) })
        .catch(() => { /* 信号不可得照常 —— 大事报缺席（本就「没事不显示」） */ })
    }
    pull()
    const timer = targetLive && isLive ? setInterval(pull, 5000) : null
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [targetId, targetWs, targetLive, isLive])

  const ctx: RunCtx = {
    task, detail, specPhases, phaseViews, tree, aggMap, totalAgg, runsById,
    now, isLive, events, signals, refetch, onMutated,
    openAcceptance: () => setSurfaceTab("accept"),
    openTrigger: () => setTriggerOpen(true),
  }

  // ── 导航条动作 ─────────────────────────────────────────────────────
  // canAbort / canReopen 读**持久**态，刻意不切派生态：暂停期间持久态仍是 running，
  // 这正是中止这条逃生口要保持畅通的原因（暂停的退出只有恢复与中止）。canAbort 因
  // 此在暂停时天然为真 —— 已由 server 侧测试钉住。
  const canAbort = task.status === "running" || task.status === "ready"
  const canReopen = task.status === "ready"
  const dueAt = task.next_fire_at
  const armedFuture = !!dueAt && new Date(dueAt).getTime() > Date.now()
  const waitingForSlot = task.execution?.status === "pending"
  const liveRun = runs.find((r) => LIVE_RUN_STATUSES.has(r.status)) ?? null
  const awaitingPv = phaseViews.find((p) => p.status === "awaiting_review") ?? null
  // 暂停/恢复只在「真有一轮在跑/被按住」时出现 —— 与工作流页同判据（服务端也要求
  // 执行确实 running 才接受暂停；停在审批节点的运行不在其列）。
  const runningRun = runs.find((r) => r.status === "running") ?? null
  const pausedRun = runs.find((r) => r.status === "paused") ?? null
  const canPause = !!runningRun
  const canResume = !!pausedRun
  const awaitingRun = awaitingPv?.awaitingRound != null
    ? runsById.get(awaitingPv!.rounds.find((r) => r.roundIndex === awaitingPv!.awaitingRound)?.exec.id ?? "") ?? null
    : null
  const waitedMs = awaitingRun?.completed_at ? Math.max(0, now - Date.parse(awaitingRun.completed_at)) : null

  // keep-mounted 触发：待验收轮一出现（或用户点过验货台）即常挂载，此后不随派生态消失而卸载。
  useEffect(() => {
    if (awaitingPv) setAcceptMounted(true)
  }, [awaitingPv])

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
  // duplicate — 整单复制（spec/issues/自写 workflows 全量带走），副本默认直入
  // 待执行；源是半草稿时 gate 不过 → 副本留草稿 + missing 说清楚。
  const handleDuplicate = async () => {
    setBusy("duplicate")
    try {
      const result = await duplicateTask(task.id)
      if (result.gate_missing?.length) {
        toast.warning(`副本已存为草稿（未入队）：缺 ${result.gate_missing.join("、")}`)
      } else {
        toast.success(`已复制「${result.task.name}」到待执行`)
      }
      for (const w of result.warnings ?? []) toast.warning(w)
      onMutated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "复制失败")
    } finally { setBusy(null) }
  }

  const handlePause = async () => {
    setBusy("pause")
    try {
      await pauseTask(task.id)
      toast.success("已暂停 — 恢复时会从被打断的节点重跑")
      onMutated(); refetch()
    } catch (err: unknown) {
      // 409 的 message 已是面向用户的中文（排队中 / 停在审批节点 / 没有进行中的执行），
      // 直接透出比换成一句笼统的「暂停失败」有用。
      toast.error(err instanceof Error ? err.message : "暂停失败")
    } finally { setBusy(null) }
  }
  // 恢复不带输入框 —— 与工作流页完全一致（workflow-flow-panel.resumeExecution 也只在
  // 调用方能给时才带 intervention；execution-panel 干脆不带 body）。intervention 是
  // API 能力，不是这里的必经步骤；想要的是一模一样的操作手感。
  const handleResume = async () => {
    setBusy("resume")
    try {
      await resumeTask(task.id)
      toast.success("已恢复运行")
      onMutated(); refetch()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "恢复失败")
    } finally { setBusy(null) }
  }

  const barBtn = "rounded border-[1.5px] border-pop-bg/30 px-1.5 py-px text-[9.5px] font-black text-pop-bg transition-colors hover:border-pop-yellow hover:text-pop-yellow"

  return (
    <FoldProvider taskId={task.id}>
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
          data-task-modal-status={derivedStatus}
          className={`shrink-0 rounded-full border-[1.5px] px-2 py-px text-[10px] font-black ${TASK_PILL[derivedStatus] ?? "border-pop-bg/30 text-pop-bg/70"}`}
        >
          {derivedStatus === "awaiting_review" && awaitingPv
            ? `◆ 待验收 · P${awaitingPv.index}`
            : `● ${TASK_STATUS_LABEL[derivedStatus] ?? derivedStatus}`}
        </span>
        {/* 语境 token：一条把「现在最该知道的数」说完 */}
        {derivedStatus === "ready" && (armedFuture
          ? <span className="shrink-0 text-pop-bg/70">⏰ 已定时 <b className="text-pop-bg">{clockShort(dueAt)}</b> 触发</span>
          : waitingForSlot
            ? <span className="shrink-0 text-pop-amber">⏳ 已到点，等并发闸…</span>
            : <span className="shrink-0 text-pop-bg/70">⚡ 待触发 · {specPhases.length || phaseViews.length} phases</span>)}
        {derivedStatus === "running" && liveRun && (
          <>
            <span className="shrink-0 text-pop-bg/70">⏱ <b className="text-pop-bg tabular-nums">{liveDur(liveRun, now)}</b>{liveRun.phase_index != null ? `（P${liveRun.phase_index}·R${liveRun.round_index ?? 1}）` : ""}</span>
            {totalAgg && totalAgg.totalCalls > 0 && (
              <AggInline agg={totalAgg} className="shrink-0 font-mono text-pop-bg/70" dim="text-pop-bg/45" />
            )}
          </>
        )}
        {/* 暂停：不显秒表（时间不在走），只说「等你恢复」 */}
        {derivedStatus === "paused" && (
          <span className="shrink-0 text-pop-bg/70">⏸ 已暂停{pausedRun?.phase_index != null ? `（P${pausedRun.phase_index}·R${pausedRun.round_index ?? 1}）` : ""} · 恢复后从该节点重跑</span>
        )}
        {derivedStatus === "awaiting_review" && waitedMs != null && (
          <span className="shrink-0 text-pop-bg/70">等你放行 · 已等 <b className="text-pop-amber">{shortDur(waitedMs)}</b></span>
        )}
        {derivedStatus === "archiving" && <span className="shrink-0 text-pop-bg/70">🗄 归档编排中（全绿才 done）</span>}
        {(derivedStatus === "done" || derivedStatus === "failed" || derivedStatus === "aborted") && task.completed_at && (
          <span className="shrink-0 text-pop-bg/70">{clockShort(task.completed_at)}{totalAgg && totalAgg.totalCalls > 0 ? ` · ${formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)}` : ""}</span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {canReopen && (
            <button onClick={() => void handleReopen()} disabled={busy !== null} data-task-reopen className={barBtn} title="退回草稿继续修改">
              ↺ 退回草稿
            </button>
          )}
          {task.status === "awaiting_review" && (
            <button onClick={() => setSurfaceTab("accept")} data-acceptance-open-bar className={barBtn} title="切到验货台 tab（摘要/实物·核对/动作）">
              🔍 验货台
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
          {/* task-pause: 暂停/恢复 —— 委派给绑定执行，与工作流页同操作。
              只有真有一轮 running 时才给「暂停」（服务端同样只认 running：停在审批
              节点的运行是引擎活着在等人，标成已暂停会把「需要你审批」盖掉）。 */}
          {canPause && (
            <button
              onClick={() => void handlePause()}
              disabled={busy !== null}
              data-task-pause
              className={barBtn}
              title="暂停这一轮（中断当前节点；恢复时从该节点重跑）"
            >
              {busy === "pause" ? <Spinner className="size-2.5" /> : "⏸ 暂停"}
            </button>
          )}
          {canResume && (
            <button
              onClick={() => void handleResume()}
              disabled={busy !== null}
              data-task-resume
              className="rounded border-[1.5px] border-pop-green/60 px-1.5 py-px text-[9.5px] font-black text-[#33d69f] transition-colors hover:bg-pop-green hover:text-white"
              title="恢复运行（从被打断的节点继续）"
            >
              {busy === "resume" ? <Spinner className="size-2.5" /> : "▶ 恢复"}
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
          {/* duplicate: 任意状态可用 —— 实现不满意 → 整单复制再跑一单。 */}
          <button
            onClick={() => void handleDuplicate()}
            disabled={busy !== null}
            data-task-duplicate
            className={barBtn}
            title="复制整单（spec/issues/自写 workflows 全量）→ 新任务直入待执行"
          >
            {busy === "duplicate" ? <Spinner className="size-2.5" /> : "⧉ 复制"}
          </button>
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
          showMaster={!(awaitingPv || surfaceTab === "accept")}
        />
        <div className="flex min-w-0 flex-1 flex-col bg-pop-bg">
          {/* ── surface tabs（2026-09-16）：有待验收轮时亮出「执行控制台 | 验货台」
              二档 —— 验货台从独立弹窗收编为 tab，继承父窗拖拽/缩放/全屏。
              打回后派生态暂无 awaiting（修复轮在跑），若用户正停在验货台看
              回显卡，条不撤（撤了就等于把 seam 踢没）。 ── */}
          {(awaitingPv || surfaceTab === "accept") && (
            <div className="flex shrink-0 items-center gap-1.5 border-b-[2px] border-pop-bd/15 bg-pop-paper px-3 py-1.5" data-console-tabs>
              <button
                onClick={() => setSurfaceTab("console")}
                aria-selected={surfaceTab === "console"}
                data-console-tab="console" data-testid="console-tab-console"
                className={`rounded-full border-[2px] px-2.5 py-px font-mono text-[10.5px] font-black tracking-[.06em] transition-transform ${
                  surfaceTab === "console"
                    ? "border-pop-bd bg-pop-yellow text-pop-ink shadow-pop-sm"
                    : "border-pop-bd/25 text-pop-dim hover:border-pop-bd/60"
                }`}
              >
                ▶ 执行控制台
              </button>
              <button
                onClick={() => setSurfaceTab("accept")}
                aria-selected={surfaceTab === "accept"}
                data-console-tab="accept" data-testid="console-tab-accept"
                className={`flex items-center gap-1 rounded-full border-[2px] px-2.5 py-px font-mono text-[10.5px] font-black tracking-[.06em] transition-transform ${
                  surfaceTab === "accept"
                    ? "border-pop-bd bg-pop-amber text-white shadow-pop-sm"
                    : "border-pop-amber/50 bg-pop-amber-soft text-pop-amber hover:border-pop-bd/60"
                }`}
              >
                🔍 验货台
                {awaitingPv && <span className="tabular-nums opacity-80">P{awaitingPv.index}·R{awaitingPv.awaitingRound}</span>}
              </button>
              <FoldMasterChip className="ml-auto" />
            </div>
          )}
          {/* keep-mounted：见 acceptMounted 声明处注释。hidden 切换而非三元卸载，
              复检会话/走查 gate/编辑草稿活过 tab 往返；e2e 的 [data-acceptance-modal]
              可见性断言不受影响（Radix 之外，hidden 属性即 Playwright 不可见）。 */}
          {acceptMounted && (
            <div className={`min-h-0 flex-1 bg-pop-paper ${surfaceTab !== "accept" ? "hidden" : ""}`}>
              {/* detail 单源：控制台的 GET /:id 快照 + 重拉通道直接注入（嵌入式
                  AcceptanceSurface 不再自养第三份副本 / 重复订 phase 事件）。 */}
              <AcceptanceSurface
                task={task}
                detailOverride={detail}
                onRefetch={refetch}
                onMutated={() => { onMutated(); refetch() }}
                onDecided={() => setSurfaceTab("console")}
              />
            </div>
          )}
          {surfaceTab !== "accept" && (
            <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
              {view !== "report" && derived && runs.length > 0 && (
                <TaskAiUsageCard
                  agg={totalAgg} loading={!aggLoaded} runCount={runs.length}
                  rounds={runs.map((r) => ({ key: r.id, label: execLabel(r), agg: aggMap[r.id] ?? null }))}
                />
              )}
              {view === "report" || !derived
                ? <ReportSurface ctx={ctx} />
                : (() => {
                  const pv = phaseViews.find((p) => p.index === view)
                  return pv ? <PhaseSurface ctx={ctx} pv={pv} /> : <ReportSurface ctx={ctx} />
                })()}
            </div>
          )}
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
          sseLive ? (
            <span className="ml-auto flex items-center gap-1.5 text-pop-cyan">SSE<i className="block size-[7px] animate-pulse rounded-full bg-pop-cyan" /></span>
          ) : (
            // 旧实现只看任务态常亮脉冲 —— 断线后照亮，盘面停在旧快照却「看起来是活的」。
            <span className="ml-auto flex items-center gap-1.5 text-pop-red" title="实时连接中断 — 盘面为断线前快照，浏览器/管理器会自动重连">SSE 断线<i className="block size-[7px] rounded-full bg-pop-red" /></span>
          )
        ) : (
          <span className="ml-auto text-pop-bg/35">终态 · 已停轮询</span>
        )}
      </div>

      {/* 对话框宿主（单实例）—— 验货台已收编为上方 tab，不再挂弹窗。 */}
      <TriggerDialog open={triggerOpen} onOpenChange={setTriggerOpen} task={task} onTriggered={() => { onMutated(); refetch() }} />
    </div>
    </FoldProvider>
  )
}

// ── 左 rail：Phase 流水线（唯一状态位）──────────────────────────────

function PipelineRail({ ctx, budgetMs, view, onSelect, isV4, aggLoaded, showMaster }: {
  ctx: RunCtx; budgetMs: number; view: number | "report"; onSelect: (v: number | "report") => void; isV4: boolean; aggLoaded: boolean
  /** tab 条缺席（非待验收）时，一键盘落 rail 头部；有 tab 条则让位，绝不同时出两枚。 */
  showMaster: boolean
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
        {showMaster && <span className="ml-auto"><FoldMasterBar /></span>}
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
            ? <>账目 <b className="text-pop-ink">{formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)}</b> · <b className="text-pop-ink">{totalAgg.totalCalls}</b> 次请求</>
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
