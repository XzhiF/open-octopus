// packages/web-app/components/tasks/run-console/task-run-console.tsx
//
// TaskRunConsole —— 统一任务控制台壳（票 02 · taskboard-modal-v2）。
// 待执行/执行中/待验收/终态 三类卡片点开的是同一个壳（旧 simple-execution/done/
// terminal 三模式在本壳收敛为单一 "console" ModalMode；composite/authoring 不动）。
//
//   ┌ 顶栏（票 02 瘦身，原型 .m-head）：标题 + 状态 pill + ⏱/成本/commits/P·R 元信息
//   │   + ⛶/✕ —— 不再有动作按钮，红黄蓝「红绿灯」装饰删除（消除误点错觉）。
//   ├ 左：页签条（装配表 = tab-assembly.ts：running 变更·节点·控制台 /
//   │     awaiting_review 对话·变更·走查·日志 …；←/→ 切页，输入聚焦不劫持）
//   │     + 页签内容区（走查 = AcceptanceSurface keep-mounted；控制台 = 原
//   │     Phase/Report 面；变更 = 票 03 FilesTab（round-diff 单源节拍在本壳）；
//   │     节点 = 票 04 NodesTab（只读清单+深链）；对话 = 票 07 挂载位，当前占位）。
//   ├ 右 rail（原型 .m-rail）：Phase 流水线（唯一状态位，票 11 钉点全保）
//   │   + LIVE/验收卡 + 底部动作区 [data-rail-acts]（⏸/▶/■/⚡/↺/⧉/✓/↩ ——
//   │   全部接既有 handler，通过/打回接 AcceptanceSurface 决策入口，行为零回退）。
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
  PHASE_STATUS_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, TASK_EXECUTION_EVENT,
  TASK_STATUS_EVENT, TASK_VERIFY_EVENT,
  type Task,
} from "@octopus/shared"
import { getTask, reopenTask, abortTask, cancelTaskTrigger, pauseTask, resumeTask, duplicateTask, type TaskDetail, type TaskExecutionBadge, type TaskPhaseView } from "@/lib/tasks-api"
import { fetchAgentEvents } from "@/lib/api-client"
import type { LLMCallAggregates } from "@/lib/types"
import { subscribeSSE, subscribeSSEStatus } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatCost } from "@/lib/format"
import { computePhaseBadge, effectiveStatusOf, phaseBudgetMs } from "@/lib/task-board"
import { EditableTitle } from "../editable-title"
import { AcceptanceSurface, type AcceptanceActionApi } from "../acceptance/acceptance-surface"
import { TriggerDialog } from "../trigger-dialog"
import { useBatchTree } from "../authoring/use-batch-tree"
import {
  RUN_STATUS_LABEL, mergeAggregates, useRunsAggregates, TaskAiUsageCard, execLabel,
} from "../execution-summary"
import { PhaseSurface, ReportSurface, type RunCtx, type StreamEvent } from "./phase-surface"
import { FilesTab } from "../files-tab/files-tab"
import { useRoundDiffFeed } from "../files-tab/use-round-diff-feed"
import { canServeRoundDiff, scopeTotals } from "../files-tab/files-tab-model"
import { FoldMasterChip, FoldProvider } from "../fold-context"
import { buildSignals, type SignalLine } from "./signal-build"
import {
  PHASE_PILL, PHASE_STATUS_LABEL, TASK_PILL, TASK_STATUS_LABEL,
  clockShort, phaseTileTone, roundGlyph, roundOverBudget, roundTone, sumRunMs,
} from "./phase-status"
import {
  assembleRailActions, assembleTabs, cycleTab, tabLabel,
  type ConsoleShellMode, type ConsoleShellStatus, type ConsoleTabKey, type RailActionId,
} from "./tab-assembly"
import {
  decideResume, extractInterventions, interventionLineText, interventionStats,
  type InterventionRow, type InterventionStats, type ResumeDialogAction,
} from "./intervention"
import { ResumeInterventionDialog } from "./resume-intervention-dialog"
import { NodesTab } from "./nodes-tab"

export interface RunConsoleChrome {
  isFullscreen: boolean
  onToggleFullscreen: () => void
  /** 🎪 按住顶栏空白拖窗（与草稿窗 chrome 同契约）。 */
  onHeaderPointerDown?: (e: React.PointerEvent) => void
}

interface TaskRunConsoleProps {
  task: Task
  onMutated: () => void
  onClose: () => void
  chrome?: RunConsoleChrome
  /** 看板「验收」按钮直开时：落地即选中「✓ 走查」页签。 */
  startOnAcceptance?: boolean
}

const LIVE_RUN_STATUSES = new Set(["pending", "running", "paused", "pending_approval", "pending_resume"])
const ERROR_RUN_STATUSES = new Set(["failed", "aborted", "completed_with_failures"])
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "aborted"])

export function TaskRunConsole({ task, onMutated, onClose, chrome, startOnAcceptance }: TaskRunConsoleProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [triggerOpen, setTriggerOpen] = useState(false)
  // 票 06 · 「▶ 恢复 · 可注入干预」三分支弹框（openInject 的 React 化）。
  const [injectOpen, setInjectOpen] = useState(false)
  // ── 票 02 页签态 ──
  // tabSel = 用户显式选过的页签；undefined = 未交互，跟随装配表默认（与 phase 选择
  // 的 sel/autoView 双轨同一手法）。keep-mounted 挂载闸保留（2026-09-20 定版）：
  // 点过走查或出现待验收轮后常挂载，切页只切 hidden —— 三元卸载会把在飞的复检
  // 会话打回服务端尾 200 行、gate/编辑草稿归零。换任务时复位。
  const [tabSel, setTabSel] = useState<ConsoleTabKey | undefined>(undefined)
  const [acceptMounted, setAcceptMounted] = useState(!!startOnAcceptance)
  // AcceptanceSurface 决策入口句柄（右栏底部 通过/打回 的接线柱；走查面自己的
  // 动作列保持原样，两处按钮调同一组函数，行为单源）。
  const [acceptApi, setAcceptApi] = useState<AcceptanceActionApi | null>(null)
  const [busy, setBusy] = useState<"abort" | "reopen" | "cancel" | "pause" | "resume" | "duplicate" | null>(null)
  // 选中面：phase index | "report"；undefined = 未交互，跟随状态自动选。
  const [sel, setSel] = useState<number | "report" | undefined>(undefined)
  useEffect(() => {
    setSel(undefined)
    setTabSel(undefined)
    setAcceptMounted(!!startOnAcceptance)
    setInjectOpen(false)
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
  // diffSignal（票 03）：任务类事件每来一发 bump 一次，useRoundDiffFeed 用它做
  // 事件触发路（自带节流；真值来自既有 task_status/task_execution/phase/
  // artifacts/verify 事件，无新事件类型）。
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [diffSignal, setDiffSignal] = useState(0)
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
      refetch(); setDiffSignal((v) => v + 1)
    })
    const unExec = subscribeSSE(url, TASK_EXECUTION_EVENT, (e) => {
      const p = mine(e); if (!p) return
      const tag = p.phase_index != null ? `P${p.phase_index}·R${p.round_index ?? 1}` : (p.subunit ? `子单元 ${p.subunit}` : "run")
      const st = String(p.status)
      const reason = ERROR_RUN_STATUSES.has(st) && p.reason ? ` — ${String(p.reason)}` : ""
      push(LIVE_RUN_STATUSES.has(st) ? "▶" : st === "completed" || st === "done" || st === "success" ? "✓" : "✗",
        LIVE_RUN_STATUSES.has(st) ? "text-pop-purple" : "text-pop-green",
        `${tag} ${RUN_STATUS_LABEL[st] ?? st}${reason}`)
      refetch(); setDiffSignal((v) => v + 1)
    })
    const unPhase = subscribeSSE(url, PHASE_STATUS_UPDATE_EVENT, (e) => {
      const p = mine(e); if (!p) return
      push("■", "text-pop-amber", `P${p.phase_index ?? "?"} → ${PHASE_STATUS_LABEL[String(p.status)] ?? String(p.status)}`)
      refetch(); setDiffSignal((v) => v + 1)
    })
    // 票03 刷新动线：产物落盘（轮报告写完）与复检终态也是「现场变了」的信号。
    const unArt = subscribeSSE(url, TASK_ARTIFACTS_UPDATE_EVENT, (e) => {
      if (!mine(e)) return
      setDiffSignal((v) => v + 1)
    })
    const unVerify = subscribeSSE(url, TASK_VERIFY_EVENT, (e) => {
      if (!mine(e)) return
      setDiffSignal((v) => v + 1)
    })
    return () => { unStatus(); unExec(); unPhase(); unArt(); unVerify() }
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

  // ── 票 04：节点页签的绑定执行 = 当前面相位（view）那个 phase 的轮次执行 ──
  // 与大事报同一取轮纪律，但**不兜底偷看别轮**：选中的 phase 没跑过就如实 null，
  // NodesTab 显示空态。终态/战报面（view=report）取最后一轮 —— 只读回看。
  const nodesRun = useMemo(() => {
    if (view !== "report") {
      const pv = phaseViews.find((p) => p.index === view)
      const last = pv?.rounds[pv.rounds.length - 1]
      return last ? runs.find((r) => r.id === last.exec.id) ?? null : null
    }
    return runs[runs.length - 1] ?? null
  }, [view, phaseViews, runs])

  const [signals, setSignals] = useState<SignalLine[]>([])
  // 票 06 · ⚑ 干预行（同一发 agent-events 拉取榨出 —— 事件流持久化即留痕真相）。
  const [interventionRows, setInterventionRows] = useState<InterventionRow[]>([])
  const targetId = replayTarget?.id ?? null
  const targetWs = replayTarget?.workspace_id ?? null
  const targetLive = !!replayTarget && LIVE_RUN_STATUSES.has(replayTarget.status)
  useEffect(() => {
    if (!targetId || !targetWs) return
    let cancelled = false
    const pull = () => {
      fetchAgentEvents(targetWs, targetId)
        .then((res) => {
          if (cancelled) return
          setSignals(buildSignals(res.events, Date.now(), { live: targetLive && isLive, loopIterations: res.loopIterations }))
          setInterventionRows(extractInterventions(res.events))
        })
        .catch(() => { /* 信号/⚑ 不可得照常 —— 大事报缺席（本就「没事不显示」） */ })
    }
    pull()
    const timer = targetLive && isLive ? setInterval(pull, 5000) : null
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [targetId, targetWs, targetLive, isLive])

  const ctx: RunCtx = {
    task, detail, specPhases, phaseViews, tree, aggMap, totalAgg, runsById,
    now, isLive, events, signals, refetch, onMutated,
    openAcceptance: () => setTabSel("review"),
    openTrigger: () => setTriggerOpen(true),
  }

  // ── 页签装配（票 02 · tab-assembly 纯函数单源）────────────────────────
  // takeover/fixing 形态由 05/08 在执行推导落地后传入；壳层现在恒 flow。
  const shellMode: ConsoleShellMode = "flow"
  const tabs = useMemo(
    () => assembleTabs({
      status: derivedStatus as ConsoleShellStatus,
      mode: shellMode,
      v4: !!derived?.isV4,
      startOnAcceptance,
    }),
    [derivedStatus, shellMode, derived?.isV4, startOnAcceptance],
  )
  const tab: ConsoleTabKey = tabSel && tabs.keys.includes(tabSel) ? tabSel : tabs.defaultKey

  // ←/→ 切页：输入焦点（input/textarea/select/编辑区）与弹层内不劫持光标。
  useEffect(() => {
    if (tabs.keys.length < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return
      if (t?.closest?.('[role="dialog"], [role="listbox"], [role="combobox"], [role="menu"]')) return
      e.preventDefault()
      setTabSel((prev) => {
        const cur = prev && tabs.keys.includes(prev) ? prev : tabs.defaultKey
        return cycleTab(tabs.keys, cur, e.key === "ArrowRight" ? 1 : -1)
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [tabs])

  // ── 右栏底部动作判据（与导航条旧判据逐字一致，只是位置搬家）───────────
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

  // keep-mounted 触发：待验收轮一出现（或用户点过走查）即常挂载，此后不随派生态消失而卸载。
  useEffect(() => {
    if (awaitingPv) setAcceptMounted(true)
  }, [awaitingPv])
  useEffect(() => {
    if (tab === "review") setAcceptMounted(true)
  }, [tab])

  const railActions = assembleRailActions({
    status: derivedStatus as ConsoleShellStatus,
    mode: shellMode,
    canPause, canResume, canAbort, canReopen,
    armedFuture, canTrigger: !waitingForSlot,
  })
  // LIVE 卡 ⚑ 干预×N（票 06）：口径 = 最近一次干预的目标节点及其累计（纯函数单源）。
  const ivStats = useMemo(() => interventionStats(interventionRows), [interventionRows])

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
  // 票 06 · 恢复升级为「▶ 恢复 · 可注入干预」：rail 钮只开框，放行由三分支弹框决定 ——
  // 取消=纯关窗（暂停原样）；直接继续=不带干预；注入并继续=原文逐字走 resume(intervention)
  // （≤4000 契约不变，留痕由 ExecutionLifecycle 落 agent_events，⚑ 行走既有事件面回来）。
  const handleResume = async (intervention?: string) => {
    setBusy("resume")
    try {
      await (intervention ? resumeTask(task.id, intervention) : resumeTask(task.id))
      toast.success(intervention ? "⚑ 干预已注入 · 日志见 ⚑ 高亮行" : "已恢复运行")
      onMutated(); refetch()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "恢复失败")
    } finally { setBusy(null) }
  }
  const handleResumeAction = (action: ResumeDialogAction, text: string) => {
    const decision = decideResume(action, text)
    setInjectOpen(false)
    if (decision.kind === "close") return
    if (decision.notice) toast.warning(decision.notice)
    void handleResume(decision.intervention)
  }

  // ── 顶栏元信息（原型 .m-meta：⏱ 用时 · $ 成本 · commits · P·R）──
  const { ms: runMs, count: runCount } = sumRunMs(runs, now)
  const liveDurText = liveRun && LIVE_RUN_STATUSES.has(liveRun.status) && liveRun.status !== "paused"
    ? liveDur(liveRun, now)
    : runCount > 0 ? shortDur(runMs) : "—"
  const costText = totalAgg && totalAgg.totalCalls > 0
    ? formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)
    : "—"
  const prBadge = computePhaseBadge(derived ?? undefined)
  // ── 票 03「≡ 变更」单源节拍 ────────────────────────────────────────────
  // 壳是 round-diff 的唯一轮询者（SSE 事件 + 节流 + ≤10s 兜底）：FilesTab 吃这份
  // 载荷，顶栏 [data-head-commits] 也吃它 —— 头栏与页签永不两话。
  // 数据 = 既有 GET /round-diff（票03 起 live 轮也供货），零新端点。
  const filesServing = !!derived?.isV4 && canServeRoundDiff(derivedStatus)
  const diffFeed = useRoundDiffFeed(task.id, filesServing, diffSignal)
  // commits 元信息：aggregate 与「≡ 变更」统计条同源（scopeTotals）；无快照如实 —。
  const headCommits = diffFeed.data?.available ? scopeTotals(diffFeed.data).commits : null

  return (
    <FoldProvider taskId={task.id}>
    <div className="flex h-full min-h-0 flex-col" data-run-console={task.status}>
      {/* ── 顶栏（票 02 瘦身）：标题 + pill + 元信息 + ⛶/✕，别无其它按钮 ── */}
      <div
        data-terminal-bar
        onPointerDown={chrome?.onHeaderPointerDown}
        title={chrome ? "按住空白处拖拽移动窗口" : undefined}
        className={
          "flex h-9 shrink-0 select-none items-center gap-2 overflow-hidden whitespace-nowrap border-b-[1.5px] border-pop-bd bg-pop-idle px-3 font-mono text-[11px] text-pop-ink " +
          (chrome ? "cursor-grab touch-none active:cursor-grabbing" : "")
        }
      >
        <span aria-hidden className="shrink-0 font-black text-pop-pink">❯</span>
        <EditableTitle task={task} onMutated={onMutated} variant="term" />
        <span
          data-task-modal-status={derivedStatus}
          className={`shrink-0 rounded-full border-[1.5px] px-2 py-px text-[10px] font-black ${TASK_PILL[derivedStatus] ?? "border-pop-bd text-pop-dim"}`}
        >
          {derivedStatus === "awaiting_review" && awaitingPv
            ? `◆ 待验收 · P${awaitingPv.index}`
            : derivedStatus === "running"
              ? `● ${TASK_STATUS_LABEL[derivedStatus] ?? derivedStatus}${liveRun?.phase_index != null ? ` · P${liveRun.phase_index}·R${liveRun.round_index ?? 1}` : ""}`
              : `● ${TASK_STATUS_LABEL[derivedStatus] ?? derivedStatus}`}
        </span>
        {/* 元信息区：只读数字，零按钮（用时/成本/commits/P·R） */}
        <span className="ml-2 flex shrink-0 items-center gap-3 text-[10.5px] text-pop-dim" data-head-meta>
          <span title={runCount > 0 ? `实跑 ${runCount} 轮 —— 只计 workflow 运行段` : undefined}>⏱ <b className="font-semibold text-pop-ink tabular-nums">{liveDurText}</b></span>
          <span className="text-pop-yellow">$ <b className="tabular-nums">{costText.replace(/^\$\s*/, "")}</b></span>
          <span data-head-commits={headCommits ?? "pending"} title="本轮实物提交数 —— 与「≡ 变更」统计条同源（round-diff）">{headCommits ?? "—"} commits</span>
          {prBadge && (
            <span className="tabular-nums">P {prBadge.phase}/{prBadge.total}{prBadge.round != null ? ` · R${prBadge.round}` : ""}</span>
          )}
        </span>
        {/* 语境 token（就绪/暂停/等待放行等「现在最该知道的一句话」，只读） */}
        {derivedStatus === "ready" && (armedFuture
          ? <span className="shrink-0 text-pop-dim">⏰ 已定时 <b className="text-pop-ink">{clockShort(dueAt)}</b> 触发</span>
          : waitingForSlot
            ? <span className="shrink-0 text-pop-amber">⏳ 已到点，等并发闸…</span>
            : <span className="shrink-0 text-pop-dim">⚡ 待触发 · {specPhases.length || phaseViews.length} phases</span>)}
        {derivedStatus === "paused" && (
          <span className="shrink-0 text-pop-dim">⏸ 已暂停{pausedRun?.phase_index != null ? `（P${pausedRun.phase_index}·R${pausedRun.round_index ?? 1}）` : ""} · 恢复后从该节点重跑</span>
        )}
        {derivedStatus === "awaiting_review" && waitedMs != null && (
          <span className="shrink-0 text-pop-dim">等你放行 · 已等 <b className="text-pop-amber">{shortDur(waitedMs)}</b></span>
        )}
        {derivedStatus === "archiving" && <span className="shrink-0 text-pop-dim">🗄 归档编排中（全绿才 done）</span>}
        {(derivedStatus === "done" || derivedStatus === "failed" || derivedStatus === "aborted") && task.completed_at && (
          <span className="shrink-0 text-pop-dim">{clockShort(task.completed_at)}{totalAgg && totalAgg.totalCalls > 0 ? ` · ${formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete)}` : ""}</span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {chrome && (
            <button
              onClick={chrome.onToggleFullscreen}
              title={chrome.isFullscreen ? "退出全屏 (Esc)" : "全屏"}
              aria-label="全屏"
              className="rounded border-[1.5px] border-transparent p-1 text-pop-dim transition-colors hover:border-pop-bd hover:text-pop-yellow"
            >
              {chrome.isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            className="grid size-[22px] shrink-0 place-items-center rounded-[8px] border-[1.5px] border-pop-bd bg-pop-red text-[11px] font-black leading-none text-pop-ink shadow-pop-sm transition-colors pop-press hover:brightness-110"
          >
            <span aria-hidden>✕</span>
          </button>
        </span>
      </div>

      {/* ── 主体：左（页签+内容）· 右 rail（原型 .m-body / .m-rail）── */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-pop-bg">
          {/* 页签条（装配表驱动；count 徽标随 03/04 填充） */}
          <div className="flex shrink-0 items-center gap-1.5 border-b-[1.5px] border-pop-bd bg-pop-paper py-1.5 pl-3 pr-2.5" data-console-tabs>
            {tabs.keys.map((k) => (
              <button
                key={k}
                onClick={() => setTabSel(k)}
                aria-selected={tab === k}
                data-console-tab={k}
                data-testid={`console-tab-${k}`}
                className={`flex items-center gap-1 rounded-full border-[1.5px] px-2.5 py-px font-mono text-[10.5px] font-black tracking-[.06em] transition-transform ${
                  tab === k
                    ? "border-pop-bd bg-pop-yellow text-pop-bg shadow-pop-sm"
                    : "border-pop-bd text-pop-dim hover:border-pop-bd/60"
                }`}
              >
                {tabLabel(k, { status: derivedStatus as ConsoleShellStatus, mode: shellMode })}
                {k === "review" && awaitingPv && (
                  <span className="tabular-nums opacity-80">P{awaitingPv.index}·R{awaitingPv.awaitingRound}</span>
                )}
              </button>
            ))}
            <FoldMasterChip className="ml-auto" />
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {/* keep-mounted：hidden 切换而非卸载 —— 复检会话/走查 gate/编辑草稿
                活过页签往返；[data-acceptance-modal] 锚点在 surface 内原样。 */}
            {acceptMounted && (
              <div className={`min-h-0 flex-1 bg-pop-paper ${tab !== "review" ? "hidden" : ""}`}>
                {/* detail 单源：控制台的 GET /:id 快照 + 重拉通道直接注入；
                    onActionApi = 右栏底部 通过/打回 的接线柱（行为单源在 surface）。 */}
                <AcceptanceSurface
                  task={task}
                  detailOverride={detail}
                  onRefetch={refetch}
                  onMutated={() => { onMutated(); refetch() }}
                  onDecided={() => setTabSel("console")}
                  onActionApi={setAcceptApi}
                />
              </div>
            )}
            {tab === "console" && (
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
                <InterventionStream rows={interventionRows} />
              </div>
            )}
            {tab === "files" && (
              // 票 03 落地：GitHub Files-changed 视图（统计条/口径切换/行内双行号 diff）。
              // 票 07 契约：需要给文件行挂 💬chat 徽标时，把 rowDecor/toolbarExtra 传进来。
              <div className="flex min-h-0 flex-1 flex-col" data-tab-host="files">
                <FilesTab
                  taskId={task.id}
                  feed={diffFeed}
                  serving={filesServing}
                  isLive={isLive}
                  costText={costText}
                />
              </div>
            )}
            {tab === "nodes" && (
              // 票 04 落地：◆ 节点 —— 绑定执行的只读任务清单（✓/●/⏸/○/⏹ + 类型徽标 +
              // 用时/成本 + 展开事件流含 ⚑ 行）；手术式操作经深链去执行详情视图。
              // takeover/fixing 形态走同一组件（shellMode 由 08 点亮；修复轮按
              // 05 契约从执行行 workflow_ref 自判）。
              <div className="min-h-0 flex-1 overflow-y-auto p-4" data-tab-host="nodes">
                <NodesTab run={nodesRun} mode={shellMode} live={isLive} />
              </div>
            )}
            {tab === "chat" && (
              // 票间挂载位契约（07 对话）：内容组件替换这块 placeholder 即可，
              // 页签装配、键盘、右栏、keep-mounted、变更取数节拍都已就位。
              <div className="min-h-0 flex-1 overflow-y-auto p-4" data-tab-host={tab}>
                <div className="mx-auto mt-10 max-w-[560px] rounded-xl border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-6 py-8 text-center font-mono text-[11px] leading-relaxed text-pop-dim">
                  💬 对话页签 —— task-doer 快速修改/接管对话由<b className="text-pop-ink">票 07</b> 挂载。数据源 = S1 GET/POST /api/tasks/:id/chat。快改徽标接线：FilesTab 的 rowDecor/toolbarExtra 即 07 的挂载钩子。
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右 rail：Pipeline + LIVE/验收卡（滚动） + 底部动作区（钉底） */}
        <aside className="flex w-[296px] shrink-0 min-h-0 flex-col border-l-[1.5px] border-pop-bd bg-pop-idle">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PipelineRail ctx={ctx} budgetMs={budgetMs} view={view} onSelect={setSel} isV4={isV4} aggLoaded={aggLoaded} />
            <RailStatusCard
              derivedStatus={derivedStatus}
              liveRun={liveRun}
              awaitingPv={awaitingPv}
              costText={costText}
              durText={liveDurText}
              interventions={ivStats}
            />
          </div>
          <div className="flex shrink-0 flex-col gap-2 border-t-[1.5px] border-pop-bd p-3" data-rail-acts>
            {railActions.map((id) => (
              <RailActionButton
                key={id}
                id={id}
                busy={busy}
                acceptApi={acceptApi}
                handlers={{
                  trigger: () => setTriggerOpen(true),
                  triggerCancel: handleCancelTrigger,
                  reopen: handleReopen,
                  pause: handlePause,
                  resume: () => setInjectOpen(true), // 票 06：只开注入弹框，放行在框里
                  abort: handleAbort,
                  duplicate: handleDuplicate,
                }}
              />
            ))}
          </div>
        </aside>
      </div>

      {/* ── footer 状态条 ── */}
      <div className="flex h-6 shrink-0 select-none items-center gap-3 border-t-[1.5px] border-pop-bd bg-pop-idle px-3 font-mono text-[10.5px] text-pop-dim">
        <span>创建 <b className="font-semibold text-pop-ink">{clockShort(task.created_at)}</b></span>
        <span aria-hidden className="text-pop-dim/40">·</span>
        <span>{isV4 ? `v4 · ${phaseViews.length || specPhases.length} phases` : "v3 legacy"}</span>
        {liveRun?.workspace_id && (
          <>
            <span aria-hidden className="text-pop-dim/40">·</span>
            <span title={`workspace ${liveRun.workspace_id}`}>工作区 <b className="font-semibold text-pop-ink">{liveRun.workspace_id.slice(0, 8)}</b></span>
          </>
        )}
        {TERMINAL_TASK_STATUSES.has(task.status) && (
          <>
            <span aria-hidden className="text-pop-dim/40">·</span>
            <span className="text-pop-dim">{task.status === "done" ? "工作区已归档" : "工作区已清理"}</span>
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
          <span className="ml-auto text-pop-dim">终态 · 已停轮询</span>
        )}
      </div>

      {/* 对话框宿主（单实例）—— 走查面已收编为页签，不再挂弹窗。 */}
      <TriggerDialog open={triggerOpen} onOpenChange={setTriggerOpen} task={task} onTriggered={() => { onMutated(); refetch() }} />
      {/* 票 06 · 恢复注入三分支框（Esc 由 Radix 层序先关框再关窗，同 02 裁决）。 */}
      <ResumeInterventionDialog
        open={injectOpen}
        onOpenChange={setInjectOpen}
        targetNodeLabel={(pausedRun ?? liveRun)?.name || (pausedRun ?? liveRun)?.workflow_ref.replace(/^built-in\//, "") || "当前节点"}
        busy={busy === "resume"}
        onAction={handleResumeAction}
      />
    </div>
    </FoldProvider>
  )
}

// ── 右栏底部动作钮（票 02：动作区按状态装配，仍接既有实现）────────────

const RAIL_BTN = "w-full rounded-xl border-[1.5px] px-2.5 py-1.5 text-center font-mono text-[11px] font-black shadow-pop-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"

interface RailActionHandlers {
  trigger: () => void
  triggerCancel: () => void
  reopen: () => void
  pause: () => void
  resume: () => void
  abort: () => void
  duplicate: () => void
}

function RailActionButton({ id, busy, acceptApi, handlers }: {
  id: RailActionId
  busy: TaskRunConsoleBusy
  acceptApi: AcceptanceActionApi | null
  handlers: RailActionHandlers
}) {
  const spin = (k: Exclude<TaskRunConsoleBusy, null>) => busy === k ? <Spinner className="mr-1 inline size-3" /> : null
  switch (id) {
    case "trigger":
      return (
        <button onClick={handlers.trigger} disabled={busy !== null} data-task-trigger
          className={`${RAIL_BTN} border-pop-green bg-pop-green text-pop-bg hover:brightness-110`}
          title="打开触发对话框（发射门禁在「控制台」页签）">
          ⚡ 触发
        </button>
      )
    case "trigger-cancel":
      return (
        <button onClick={() => void handlers.triggerCancel()} disabled={busy !== null} data-task-trigger-cancel
          className={`${RAIL_BTN} border-pop-amber/60 text-pop-amber hover:bg-pop-amber hover:text-pop-bg`}
          title="取消定时触发">
          {spin("cancel")}✕ 取消触发
        </button>
      )
    case "reopen":
      return (
        <button onClick={() => void handlers.reopen()} disabled={busy !== null} data-task-reopen
          className={`${RAIL_BTN} border-pop-bd bg-pop-paper text-pop-ink hover:border-pop-yellow hover:text-pop-yellow`}
          title="退回草稿继续修改">
          {spin("reopen")}↺ 退回草稿
        </button>
      )
    case "pause":
      return (
        <button onClick={() => void handlers.pause()} disabled={busy !== null} data-task-pause
          className={`${RAIL_BTN} border-pop-bd bg-pop-paper text-pop-ink hover:border-pop-amber hover:text-pop-amber`}
          title="暂停这一轮（中断当前节点；恢复时从该节点重跑）">
          {spin("pause")}⏸ 暂停
        </button>
      )
    case "resume":
      return (
        <button onClick={() => handlers.resume()} disabled={busy !== null} data-task-resume
          className={`${RAIL_BTN} border-pop-amber bg-pop-amber text-pop-bg hover:brightness-110`}
          title="弹出「恢复执行 — 注入干预」：取消（保持暂停）/ 直接继续 / ⚑ 注入并继续">
          {spin("resume")}▶ 恢复 · 可注入干预
        </button>
      )
    case "abort":
      return (
        <button onClick={() => void handlers.abort()} disabled={busy !== null} data-task-abort
          className={`${RAIL_BTN} border-pop-red/60 bg-pop-paper text-pop-red hover:bg-pop-red hover:text-pop-ink`}
          title="中止任务（工作区将清理）">
          {spin("abort")}■ 中止
        </button>
      )
    case "accept":
      return (
        <button
          onClick={() => acceptApi?.requestAccept()}
          disabled={acceptApi === null || acceptApi.blocked}
          title={acceptApi?.blocked ? "存在 ✗ 未过项 —— 通过被拦，请改走打回" : "先弹台账预览确认（既有 D8 流程），确认才落决策"}
          data-rail-accept
          className={`${RAIL_BTN} border-pop-green bg-pop-green text-pop-bg hover:brightness-110`}
        >
          ✓ 验收通过
        </button>
      )
    case "reject":
      return (
        <button
          onClick={() => acceptApi?.openReject()}
          disabled={acceptApi === null}
          title="打开打回反馈框（既有表单与弹窗，行为单源在走查面）"
          data-rail-reject
          className={`${RAIL_BTN} border-pop-bd bg-pop-paper text-pop-dim hover:text-pop-pink hover:border-pop-pink/50`}
        >
          ↩ 打回 · 写反馈
        </button>
      )
    case "duplicate":
      return (
        <button onClick={() => void handlers.duplicate()} disabled={busy !== null} data-task-duplicate
          className="w-full rounded-lg border-[1.5px] border-pop-bd bg-pop-paper px-2 py-1 text-center font-mono text-[10px] font-black text-pop-dim transition-colors hover:text-pop-ink"
          title="复制整单（spec/issues/自写 workflows 全量）→ 新任务直入待执行">
          {spin("duplicate")}⧉ 复制整单
        </button>
      )
  }
}

type TaskRunConsoleBusy = "abort" | "reopen" | "cancel" | "pause" | "resume" | "duplicate" | null

// ── LIVE / 验收状态卡（原型 .live-card；⚑ 干预×N = 票 06 注入留痕计数）──────

function RailStatusCard({ derivedStatus, liveRun, awaitingPv, costText, durText, interventions }: {
  derivedStatus: string
  liveRun: TaskExecutionBadge | null
  awaitingPv: TaskPhaseView | null
  costText: string
  durText: string
  interventions: InterventionStats
}) {
  const running = derivedStatus === "running" && liveRun
  const paused = derivedStatus === "paused"
  const awaiting = derivedStatus === "awaiting_review" && awaitingPv
  const hd = awaiting
    ? `◔ 验收 · P${awaitingPv!.index}·R${awaitingPv!.awaitingRound ?? "?"}`
    : paused
      ? `⏸ PAUSED${liveRun?.phase_index != null ? ` · P${liveRun.phase_index}·R${liveRun.round_index ?? 1}` : ""}`
      : running
        ? `▶ LIVE ROUND · R${liveRun.round_index ?? 1}`
        : derivedStatus === "ready"
          ? "⚡ READY"
          : derivedStatus === "archiving"
            ? "🗄 归档中"
            : `■ ${TASK_STATUS_LABEL[derivedStatus] ?? derivedStatus}`
  return (
    <div className="mx-2.5 mb-2.5 overflow-hidden rounded-xl border-[1.5px] border-pop-purple/60" data-testid="rail-live-card">
      <div className="flex items-center gap-2 bg-pop-purple-soft px-3 py-1.5 font-mono text-[10px] font-black text-pop-purple">
        {hd}
        <span className="ml-auto tabular-nums text-pop-ink">{durText}</span>
      </div>
      <div className="flex flex-col gap-1 bg-pop-paper px-3 py-2 font-mono text-[10.5px] text-pop-dim">
        {(running || paused) && liveRun && (
          <span>节点 <b className="text-pop-ink">{liveRun.name || liveRun.workflow_ref.replace(/^built-in\//, "")}</b>{liveRun.phase_index != null ? ` · P${liveRun.phase_index}·R${liveRun.round_index ?? 1}` : ""}{interventions.currentNodeCount > 0 && (
            <span className="font-black text-pop-pink" data-testid="rail-intervention-chip"> · ⚑ 干预×{interventions.currentNodeCount}</span>
          )}</span>
        )}
        {awaiting && <span>执行结果 <b className="text-pop-ink">等你放行</b></span>}
        {derivedStatus === "ready" && <span>等触发 · 发射门禁见「控制台」页签</span>}
        <span>成本 <b className="text-pop-ink">{costText}</b> / 变更 <b className="text-pop-ink">≡ 见「变更」页签</b></span>
        {paused && <span className="text-pop-amber">暂停中 —— 点下方恢复钮：可注入 ⚑ 干预纠偏，或直接继续</span>}
      </div>
    </div>
  )
}

// ── ⚑ 人工干预流水（票 06：高亮行 = pink，原型 .cl.iv 语调）────────────
// 数据面 = agent_events 'intervention' 行（ExecutionLifecycle.resume(intervention)
// 留痕）经 extractInterventions 榨出 —— 没有干预时整块不存在（不打扰模式的呈现面）。

function InterventionStream({ rows }: { rows: InterventionRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="mt-2.5 space-y-1" data-testid="intervention-log">
      <div className="px-0.5 font-mono text-[9.5px] font-black tracking-[.1em] text-pop-pink/80">⚑ 人工干预 / INTERVENTION</div>
      {rows.map((r, i) => {
        const line = interventionLineText(r)
        return (
          <div
            key={`${r.at}-${i}`}
            data-testid="intervention-line"
            title={line}
            className="truncate rounded-lg border-[1.5px] border-pop-pink/50 bg-pop-pink-soft px-2 py-1 font-mono text-[11px] text-pop-pink"
          >
            {line}
            {r.at && <span className="ml-1.5 text-[9.5px] text-pop-dim">{clockShort(r.at)}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── 右 rail：Phase 流水线（唯一状态位）──────────────────────────────
// 票 02：从左侧搬进右栏（原型 .m-rail 语义）；票 11 钉点 testid 原样保留。

function PipelineRail({ ctx, budgetMs, view, onSelect, isV4, aggLoaded }: {
  ctx: RunCtx; budgetMs: number; view: number | "report"; onSelect: (v: number | "report") => void; isV4: boolean; aggLoaded: boolean
}) {
  const { task, detail, phaseViews, now, totalAgg } = ctx
  const derived = detail?.derived
  const terminal = TERMINAL_TASK_STATUSES.has(task.status)
  const runs = detail?.executions ?? []
  const { ms: runMs, count: runCount } = sumRunMs(runs, now)

  return (
    <div className="min-h-0 px-2.5 py-2.5" data-testid="phase-timeline" data-run-rail>
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
          className={`mb-1 flex w-full items-center gap-2 rounded-xl border-[1.5px] bg-pop-bg px-2 py-1.5 text-left shadow-pop-sm transition-transform ${view === "report" ? "border-[1.5px] border-pop-bd outline outline-[2px] outline-pop-yellow outline-offset-[1.5px]" : "border-pop-bd/70 hover:-translate-y-px"}`}
        >
          <span className="grid size-[18px] shrink-0 place-items-center rounded-[6px] border-[1.5px] border-pop-bd bg-pop-idle font-mono text-[9px] font-black text-pop-dim">V3</span>
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
                  selNode ? "border-[1.5px] border-pop-bd outline outline-[2px] outline-pop-yellow outline-offset-[1.5px]" : "border-[1.5px] border-pop-bd/70"
                } ${p.status === "awaiting_review" ? "bg-pop-amber-soft" : ""}`}
              >
                <span className={`grid shrink-0 place-items-center rounded-[8px] border-[1.5px] border-pop-bd font-mono font-black ${selNode ? "size-[24px] text-[10.5px]" : "size-[18px] text-[9px]"} ${phaseTileTone(p.status, nextUp)}`}>
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

      <div className="mt-3 space-y-0.5 border-t-[1.5px] border-dashed border-pop-bd px-1 pt-2 font-mono text-[10px] text-pop-dim">
        <div title={`创建 ${task.created_at}\n实跑 ${runCount} 轮 —— 只计 workflow 运行段，不含排队/待验收等待`}>
          创建 <b className="text-pop-ink">{clockShort(task.created_at)}</b> · 实际用时 <b className="text-pop-ink">{runCount > 0 ? shortDur(runMs) : "—"}</b>（{runCount} 轮）
        </div>
        <div>预算 <b className="text-pop-ink">{Math.round(budgetMs / 60000)}</b> 分/phase（advisory ⏳）</div>
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
      className={`mb-2 w-full rounded-lg border-[1.5px] px-2 py-1 text-left font-mono text-[10px] font-black transition-colors ${
        active ? "border-pop-bd bg-pop-yellow text-pop-bg shadow-pop-sm" : "border-pop-bd bg-pop-bg text-pop-dim hover:border-pop-bd"
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
