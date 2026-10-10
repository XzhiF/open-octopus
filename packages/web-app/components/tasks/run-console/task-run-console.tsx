// packages/web-app/components/tasks/run-console/task-run-console.tsx
//
// TaskRunConsole —— 统一任务控制台壳（票 02 · taskboard-modal-v2）。
// 待执行/执行中/待验收/终态 三类卡片点开的是同一个壳（旧 simple-execution/done/
// terminal 三模式在本壳收敛为单一 "console" ModalMode；composite/authoring 不动）。
//
//   ┌ 顶栏（票 02 瘦身，原型 .m-head）：标题 + 状态 pill + ⏱/成本/commits/P·R 元信息
//   │   + ⛶/✕ —— 不再有动作按钮，红黄蓝「红绿灯」装饰删除（消除误点错觉）。
//   ├ 左：页签条（装配表 = tab-assembly.ts：ready(原型⓬票07) 对话·规格·节点 默认节点 /
//   │     running 变更·节点·消耗·产物·控制台 /
//   │     awaiting_review 对话·变更·走查·消耗·产物·日志 …；←/→ 切页，输入聚焦不劫持）
//   │     内容区净黑同底（⑪真机复点：走查/日志不再垫 bg-pop-paper 亮卡；日志盒
//   │     = inset 衬底铺到底 + 贴底自动跟随，原型 m-content/.console 口径）。
//   │     + 页签内容区（走查 = AcceptanceSurface keep-mounted + railless（票11：
//   │     「摘要+动作」内列撤场）；控制台/日志 = 纯工作区事件流（票11 归位 +
//   │     用户终裁：实时追加走既有 executions/events SSE、轮询只作兜底/首屏（收口①）；
//   │     ⚑ 留痕只在流内一行不叠 digest（收口②），testid 契约 intervention-log/line
//   │     转钉流内高亮行；旧 Phase/Report 叠面（门禁/交付报告/轮次账本/盘上文件/
//   │     大事报/战报瓦片）整体撤场不再另找落点）；
//   │     消耗 = TaskAiUsageCard 三段 + 按会话/节点明细（票11）；
//   │     产物 = 分组清单 + 预览/复制（票11，manifest 端点；徽标按件数>0 挂，收口⑥）；
//   │     变更 = 票 03 FilesTab（round-diff 单源节拍在本壳）；
//   │     节点 = 票 04 NodesTab（只读清单+深链）；对话 = 票 07 TaskChatTab，
//   │     三形态（快改/接管/修复轮追加指令）按 shellMode+派生态换语义）。
//   ├ 右 rail（原型 .m-rail）：Phase 流水线（唯一状态位，票 11 钉点全保）
//   │   + LIVE/验收卡 + 底部动作区 [data-rail-acts]（⏸/▶/■/⚡/↺/⧉/✓/↩ ——
//   │   全部接既有 handler，通过/打回/中止接 AcceptanceSurface 决策入口（票11
//   │   中止归栏 = requestAbort 二次确认句柄；句柄不在场的兜底同样过 ConfirmDialog
//   │   二次确认才落端点，收口⑦）。⑪真机复点 · 待验收四钮定版（顺序/文案/配色
//   │   逐字对齐原型 railWait）：✓ 验收通过（绿实心）→ ↩ 反馈打回 · task-fix 修复
//   │   轮（大改）（粉衬底粉字）→ 🗂 工作空间 · P<ph> 执行视图 ↗（青底，
//   │   deepLinkTarget 同源 URL 新标签）→ ■ 中止任务（红衬底红字）；duplicate
//   │   照旧尾随。工作空间钮只进 awaiting 装配，run/takeover/fixing 右栏不动。
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
  PHASE_STATUS_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, TASK_EXECUTION_EVENT,
  TASK_STATUS_EVENT, TASK_VERIFY_EVENT,
  type Task,
} from "@octopus/shared"
import { getTask, reopenTask, abortTask, cancelTaskTrigger, pauseTask, resumeTask, duplicateTask, takeoverTask, deliverTakeover, postFixRound, getArtifactManifest, type TaskDetail, type TaskExecutionBadge, type TaskPhaseView } from "@/lib/tasks-api"
import { fetchAgentEvents } from "@/lib/api-client"
import type { AgentEvent, ArtifactManifestBody, LLMCallAggregates } from "@/lib/types"
import { subscribeSSE, subscribeSSEStatus } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatCost } from "@/lib/format"
import { ConfirmDialog } from "@/components/scheduler/confirm-dialog"
import { computePhaseBadge, effectiveStatusOf, phaseBudgetMs } from "@/lib/task-board"
import { EditableTitle } from "../editable-title"
import { AcceptanceSurface, type AcceptanceActionApi } from "../acceptance/acceptance-surface"
import { TriggerDialog } from "../trigger-dialog"
import {
  LIVE_STATUSES, mergeAggregates, useRunsAggregates, execLabel, deepLinkTarget,
} from "../execution-summary"
import { FilesTab } from "../files-tab/files-tab"
import { useRoundDiffFeed } from "../files-tab/use-round-diff-feed"
import { canServeRoundDiff, scopeTotals } from "../files-tab/files-tab-model"
import { FoldMasterChip, FoldProvider } from "../fold-context"
import {
  PHASE_PILL, PHASE_STATUS_LABEL, SHELL_MODE_LABEL, TASK_PILL, TASK_STATUS_LABEL,
  clockShort, phaseTileTone, roundGlyph, roundOverBudget, roundTone, sumRunMs,
} from "./phase-status"
import {
  assembleRailActions, assembleTabs, cycleTab, tabLabel, deriveShellMode,
  type ConsoleShellMode, type ConsoleShellStatus, type ConsoleTabKey, type RailActionId,
} from "./tab-assembly"
import {
  decideResume, extractInterventions, interventionStats,
  type InterventionStats, type ResumeDialogAction,
} from "./intervention"
import { agentEventFromWire, retainNewerThan } from "./log-model"
import { ResumeInterventionDialog } from "./resume-intervention-dialog"
import { TakeoverBranchDialog } from "./takeover-branch-dialog"
import { FixDispatchDialog } from "./fix-dispatch-dialog"
import { NodesTab } from "./nodes-tab"
// 票07(原型⓬ 三签票)：ready 静态节点预览 + 对话/规格占位壳（08/09 接入位）。
import { StaticNodesTab } from "./static-nodes-tab"
import { ReadyChatPlaceholder, ReadySpecPlaceholder } from "./ready-tab-placeholders"
import { WorkspaceEventStream } from "./workspace-event-stream"
import { UsageTab } from "./usage-tab"
import { ArtifactsTab } from "./artifacts-tab"
import { manifestTotalCount } from "./artifacts-model"
import { TaskChatTab, type QuickEditCommitInfo } from "./chat/chat-tab"
import { chatFormFor, diffRowHit, isTakeoverDeliveredRound, type ChatEditsView } from "./chat/chat-model"
import type { BranchChoice } from "./takeover"

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

// 在飞轮词表单源 execution-summary.LIVE_STATUSES（票10 review-2：曾在此文件
// 与 nodes-tab 各存一份逐字副本 —— 实时一跳/⚑ 计数/fixing 判定全切这一份）。
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
  // ── 票 07 对话页签接线态 ──
  // chatEdits = 本会话快改视图（quick_edit_commit 计数 + 工具卡文件），由 TaskChatTab
  // 上抛、FilesTab 消费（💬chat 徽标 + ×N chip）；reveal = 「查看 diff」跳链的一次性
  // 揭示（nonce 递增重触发，2s 后自清 —— 后续切页不谎闪）。换任务一并复位。
  const [chatEdits, setChatEdits] = useState<ChatEditsView>({ commits: 0, files: [] })
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null)
  const revealNonceRef = useRef(0)
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState<"abort" | "reopen" | "cancel" | "pause" | "resume" | "duplicate" | "takeover" | "deliver" | "fix" | null>(null)
  // 票11 双轴 review 收口⑦：rail「■ 中止」句柄不在场的兜底路径也要过二次确认
  // （ConfirmDialog 单源同款危险确认），不再直落 abortTask。
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false)
  // ── 票08 三分支弹态 ──
  // branchOpen=「✋ 有问题」决策框；fixOpen=改派 task-fix 指令框（③/接管中改派两入口共用）；
  // openingDraft=② 带过来的开场指令草稿（nonce 允许连开两框各带各的字；预填不代发）。
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchChoice, setBranchChoice] = useState<BranchChoice>("inject")
  const [fixOpen, setFixOpen] = useState(false)
  const [fixPrefill, setFixPrefill] = useState("")
  const [openingDraft, setOpeningDraft] = useState<{ text: string; nonce: number } | null>(null)
  const openingNonceRef = useRef(0)
  // 选中面：phase index | "report"；undefined = 未交互，跟随状态自动选。
  const [sel, setSel] = useState<number | "report" | undefined>(undefined)
  useEffect(() => {
    setSel(undefined)
    setTabSel(undefined)
    setAcceptMounted(!!startOnAcceptance)
    setInjectOpen(false)
    setAbortConfirmOpen(false)
    setChatEdits({ commits: 0, files: [] })
    setReveal(null)
    // 票08：换任务一并收弹态（决策框/改派框不该跨任务还魂）。
    setBranchOpen(false)
    setBranchChoice("inject")
    setFixOpen(false)
    setFixPrefill("")
    setOpeningDraft(null)
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

  // ── SSE：状态即时重拉（与退役前 TaskRunDetailView 同四路）──
  // diffSignal（票 03）：任务类事件每来一发 bump 一次，useRoundDiffFeed 用它做
  // 事件触发路（自带节流；真值来自既有 task_status/task_execution/phase/
  // artifacts/verify 事件，无新事件类型）。用户终裁（票11）：叠面撤场后
  // 活动流采集（StreamEvent 行）随之退役 —— 事件行只从工作区事件流一处呈现。
  const [diffSignal, setDiffSignal] = useState(0)
  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (e: MessageEvent): boolean => {
      try {
        const p = JSON.parse(e.data) as { task_id?: string }
        return p.task_id === task.id
      } catch { return false }
    }
    const unStatus = subscribeSSE(url, TASK_STATUS_EVENT, (e) => {
      if (!mine(e)) return
      refetch(); setDiffSignal((v) => v + 1)
    })
    const unExec = subscribeSSE(url, TASK_EXECUTION_EVENT, (e) => {
      if (!mine(e)) return
      refetch(); setDiffSignal((v) => v + 1)
    })
    const unPhase = subscribeSSE(url, PHASE_STATUS_UPDATE_EVENT, (e) => {
      if (!mine(e)) return
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

  // detail 每次重拉都是新对象 —— runs/phaseViews memo 化，下游 useMemo 的依赖才稳。
  const runs = useMemo(() => detail?.executions ?? [], [detail])
  const execIds = useMemo(() => runs.map((r) => r.id), [runs])
  const { aggMap, loaded: aggLoaded } = useRunsAggregates(execIds, isLive)
  const totalAgg = useMemo(() => mergeAggregates(Object.values(aggMap)), [aggMap])
  const runsById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs])

  // 秒表：live 且确有活轮时 1s 一跳（数据刷新仍归轮询/SSE）。
  const anyLiveRun = runs.some((r) => LIVE_STATUSES.has(r.status))
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

  // ── 日志流绑定执行锚（replayTarget）───────────────────────────────────
  // 原「大事报信号」（buildSignals 四类行，2026-09-20 定稿）随 Phase/Report 叠面
  // 退役 —— 用户终裁（票11）：异常史由流内 ✗ 行自证，不另立聚合框。这里保留的
  // 只有取轮纪律：活轮在跑时每 5s 重拉尾部；权威仍是 GET /:id derived。切轮重锚。
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

  // ── 票07(原型⓬)：ready 且当前面相位**尚无执行行** → 节点页签换绑定流静态预览 ──
  // 判据就是 nodesRun 在场与否（与动态模型同一取轮纪律）：触发转 running 后
  // nodesRun 落位自动回票 04 动态清单，无缝衔接、零新推导。预览跟面相位走
  // （rail 选哪个 pending phase 就预览哪个的绑定流）。
  const staticPreview = derivedStatus === "ready" && !nodesRun
  const staticPreviewPhase = staticPreview ? phaseViews.find((p) => p.index === view) ?? null : null

  // 票11 ⑩回补：「▶ 控制台/日志」事件流的原料 = 绑定执行的 agent_events。
  // 票11 双轴 review 收口①：优先既有 SSE 通道（GET /api/workspaces/:id/executions/events，
  // engine 以 "agent_event" emit）实时追加进 liveAppends；5s 轮询退位为兜底/首屏，
  // 每次快照回来后 retainNewerThan 自愈同刻双现。票06 ⚑ 行与 LIVE 卡计数同吃这份流。
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([])
  const [liveAppends, setLiveAppends] = useState<AgentEvent[]>([])
  const streamEvents = useMemo(
    () => (liveAppends.length === 0 ? agentEvents : [...agentEvents, ...liveAppends]),
    [agentEvents, liveAppends],
  )
  // ⚑ 干预行（票06）= 同一事实源：流内 extractInterventions（digest 叠块已撤，收口②）。
  const interventionRows = useMemo(() => extractInterventions(streamEvents), [streamEvents])
  // US16（票10 review-7）：⚑ 干预×N 的「当前节点」= 事件流尾部节点（引擎现在
  // 在往哪个节点吐事件），不是「最近一次干预打到的节点」。执行推进到没挨过
  // 干预的新节点 → 计数归 0（卡片按 >0 才挂 chip，即「0/不显示」）。
  const liveNodeId = useMemo(() => {
    const tail = streamEvents[streamEvents.length - 1]
    return tail && tail.nodeId ? tail.nodeId : null
  }, [streamEvents])
  const targetId = replayTarget?.id ?? null
  const targetWs = replayTarget?.workspace_id ?? null
  const targetLive = !!replayTarget && LIVE_STATUSES.has(replayTarget.status)
  useEffect(() => {
    if (!targetId || !targetWs) { setAgentEvents([]); setLiveAppends([]); return }
    let cancelled = false
    setLiveAppends([])
    const pull = () => {
      fetchAgentEvents(targetWs, targetId)
        .then((res) => {
          if (cancelled) return
          // 票11 日志归位：原始事件同批留存（live 轮 5s 兜底 —— ≤10s 新事件可见）。
          setAgentEvents(res.events)
          // 收口①自愈：SSE 追加里已被这份权威快照覆盖的行即弃。
          setLiveAppends((prev) => retainNewerThan(prev, res.events))
        })
        .catch(() => { /* 事件/⚑ 不可得照常 —— 流空态如实，不编造 */ })
    }
    pull()
    const timer = targetLive && isLive ? setInterval(pull, 5000) : null
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [targetId, targetWs, targetLive, isLive])

  // ── 票11 收口① — 既有执行事件 SSE 实时追加（轮询之上的一等公民）──
  // sse-manager 按 url 共享一条 EventSource：同页已有组件订过该通道则复用，不另开
  // 第二份连接。载荷 { executionId, nodeId, event } → agentEventFromWire 只转结构
  // 性事实（⚙/✗/⚑），token 碎片由轮询合并形补全（防刷屏）。
  useEffect(() => {
    if (!targetId || !targetWs || !targetLive || !isLive) return
    const url = `${getServerUrl()}/api/workspaces/${targetWs}/executions/events`
    return subscribeSSE(url, "agent_event", (e) => {
      let p: { executionId?: string; nodeId?: string; event?: Record<string, unknown> }
      try { p = JSON.parse(e.data) as typeof p } catch { return }
      if (p.executionId !== targetId || !p.nodeId) return
      const mapped = agentEventFromWire(p.nodeId, p.event)
      if (!mapped) return
      setLiveAppends((prev) => {
        const next = [...prev, mapped]
        return next.length > 300 ? next.slice(next.length - 300) : next
      })
    })
  }, [targetId, targetWs, targetLive, isLive])

  // ── 页签装配（票 02 · tab-assembly 纯函数单源）────────────────────────
  // 形态派生唯一出口 shellMode（优先级单源 = deriveShellMode 纯函数，票08 三分支）：
  //   fixing = live 轮 workflow_ref === "built-in/task-fix"（票 05：打回恒派 task-fix）；
  //   takeover = 派生 phase 存在 'takeover'（票 08：绑定流被停、接管件未交付 ——
  //     服务端 takeover_at 标记经 deriveTaskView 补支翻出此态，交付后自动翻假）；
  //   其余一切形态恒 flow。
  const fixingLive = runs.some((r) => LIVE_STATUSES.has(r.status) && r.workflow_ref === "built-in/task-fix")
  const takeoverPv = phaseViews.find((p) => p.status === "takeover") ?? null
  const shellMode: ConsoleShellMode = deriveShellMode({ fixingLive, takeoverActive: !!takeoverPv })
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
  // 对话页签的形态（quick-edit/takeover/fixing）：与装配表同一判据源，tab=chat 在场时必非空。
  const chatForm = chatFormFor({ status: derivedStatus as ConsoleShellStatus, mode: shellMode })

  // ── 票11 ▣ 产物清单（壳层单拉 —— 页签徽标件数与 ArtifactsTab 同吃一份，不各拉各的）。
  // 刷新搭既有 diffSignal（artifacts/verify/task 事件都会 bump，落盘即现），零新通道。
  const hasArtifactsTab = tabs.keys.includes("artifacts")
  const [manifest, setManifest] = useState<ArtifactManifestBody | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  useEffect(() => {
    if (!hasArtifactsTab) return
    let cancelled = false
    setManifestLoading(true)
    getArtifactManifest(task.id)
      .then((r) => { if (!cancelled) setManifest(r) })
      // 票11 刀A（流②真机回归）：refetch 失败（浏览器层网络/代理抖动，请求未必到 server）
      // 不得伪造「暂无可列产物」覆盖已加载数据 —— 保留旧值；仅从未成功过（旧值为 null）
      // 才落空态，此时错误与真空对用户同形。不加重试（票11 追加口径）。
      .catch(() => { if (!cancelled) setManifest((prev) => prev ?? { groups: [] }) })
      .finally(() => { if (!cancelled) setManifestLoading(false) })
    return () => { cancelled = true }
  }, [task.id, hasArtifactsTab, diffSignal])

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
  const liveRun = runs.find((r) => LIVE_STATUSES.has(r.status)) ?? null
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
  // ⑪真机复点：待验收右栏「🗂 工作空间 · P<ph> 执行视图 ↗」的 URL =
  // execution-summary.deepLinkTarget 单源（撤面前 phase-surface/nodes-tab 同一函数）；
  // awaiting 轮未落 run（异常态）→ null → 按钮禁而不藏（装配顺序稳定）。
  const wsViewUrl = awaitingRun ? deepLinkTarget(awaitingRun) : null
  const waitedMs = awaitingRun?.completed_at ? Math.max(0, now - Date.parse(awaitingRun.completed_at)) : null
  // 票08：待验收轮若是接管交付件（badge 双标记）→ 对话 hint 与走查标注共用此判据。
  const takeoverDelivered = isTakeoverDeliveredRound(awaitingRun ?? undefined)

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
  // LIVE 卡 ⚑ 干预×N（票 06 / US16）：口径 = **当前节点**的累计（纯函数单源
  // interventionStats；执行推进到零干预的新节点即归 0 —— 票10 review-7）。
  const ivStats = useMemo(() => interventionStats(interventionRows, liveNodeId), [interventionRows, liveNodeId])

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

  const handlePause = async (): Promise<boolean> => {
    setBusy("pause")
    try {
      await pauseTask(task.id)
      toast.success("已暂停 — 恢复时会从被打断的节点重跑")
      onMutated(); refetch()
      return true
    } catch (err: unknown) {
      // 409 的 message 已是面向用户的中文（排队中 / 停在审批节点 / 没有进行中的执行），
      // 直接透出比换成一句笼统的「暂停失败」有用。
      toast.error(err instanceof Error ? err.message : "暂停失败")
      return false
    } finally { setBusy(null) }
  }
  // ── 票08 三分支落地 ──────────────────────────────────────────────────
  // ① 注入干预原流继续 = pauseTask → 06 注入框（暂停不成不开框 —— 没有 paused
  //   轮可恢复，注入通道不存在）。
  // ② 停流 · 人工接管 = takeover 聚合端点（abort+标记+doer 会话一发完成）→
  //   派生 phase='takeover' → shellMode 翻转 → 「💬 对话接管」页签自动装配
  //   （07 组件已备，判据就是这一行 —— §07 契约）。可选指令 = 开场草稿预填。
  // ③ 派 task-fix = 先收三分支框再开指令框（必填闸门在框内），派发走
  //   fix-round；成功后 live task-fix 轮把盘面翻到 fixing（04 已能渲）。
  const handleBranchGo = async (choice: BranchChoice, note: string) => {
    if (choice === "inject") {
      setBranchOpen(false)
      if (await handlePause()) setInjectOpen(true)
      return
    }
    if (choice === "takeover") {
      setBranchOpen(false)
      setBusy("takeover")
      try {
        const res = await takeoverTask(task.id)
        if (note) {
          openingNonceRef.current += 1
          setOpeningDraft({ text: note, nonce: openingNonceRef.current })
        }
        toast.success(res.session_error ? "✋ 已接管 — 会话未就绪：" + res.session_error : "✋ 已接管 — 「💬 对话接管」一步一交")
        setTabSel("chat")
        onMutated(); refetch()
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "接管失败")
      } finally { setBusy(null) }
      return
    }
    setBranchOpen(false)
    setFixPrefill(note)
    setFixOpen(true)
  }
  const handleFixDispatch = async (instruction: string) => {
    setFixOpen(false)
    setBusy("fix")
    try {
      await postFixRound(task.id, instruction)
      toast.success("⚙ 已派发 task-fix · 看「◆ 节点」页签推进")
      onMutated(); refetch()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "改派失败")
    } finally { setBusy(null) }
  }
  const handleDeliverTakeover = async () => {
    setBusy("deliver")
    try {
      await deliverTakeover(task.id)
      toast.success("✓ 本 Round 已交付 · 转待验收（接管件 · 自动复检未跑）")
      onMutated(); refetch()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "交付失败")
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

  // ── 票 07 · 💬 对话页签接线 ────────────────────────────────────────────
  // 快改视图（徽标/×N）在壳层驻留 —— FilesTab 与 TaskChatTab 是两个页签，谁都不许私藏。
  const handleEditsChange = useCallback((v: ChatEditsView) => setChatEdits(v), [])
  // commit 尾帧 = git 现场变了 → bump「≡ 变更」节拍（1500ms 节流闸在 feed 单源，票 03）。
  const handleQuickEditCommit = useCallback((_c: QuickEditCommitInfo) => {
    setDiffSignal((s) => s + 1)
  }, [])
  const handleJumpToDiff = useCallback((path: string) => {
    setTabSel("files")
    revealNonceRef.current += 1
    setReveal({ path, nonce: revealNonceRef.current })
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    // 一次性揭示：闪完自清 —— 之后切来切去不再谎闪。
    revealTimerRef.current = setTimeout(() => setReveal(null), 2000)
  }, [])
  useEffect(() => () => { if (revealTimerRef.current) clearTimeout(revealTimerRef.current) }, [])
  // 劝退草稿 → 打回框（05 单 textarea；句柄单源在走查面，行为零复制）。
  const handleRejectDraft = useCallback((draft: string) => {
    if (acceptApi) acceptApi.openReject(draft)
    else toast.warning("走查面尚未挂载 — 稍后再点，或直接用右栏「↩ 反馈打回」")
  }, [acceptApi])
  // 修复轮追加指令 = 票 06 的暂停→注入通道（引擎对「没有运行中的节点」的拒绝原文
  // 由 chat-tab 透出；成功后 ⚑ 行走既有 agent-events 读取面进日志）。
  const handleInterventionSend = useCallback(async (text: string) => {
    if (runs.some((r) => r.status === "running")) await pauseTask(task.id)
    await resumeTask(task.id, text)
    toast.success("⚑ 修复轮追加指令已注入 — 「▶ 控制台」见 ⚑ 高亮行")
    onMutated(); refetch()
  }, [runs, task.id, onMutated, refetch])

  // ── 顶栏元信息（原型 .m-meta：⏱ 用时 · $ 成本 · commits · P·R）──
  const { ms: runMs, count: runCount } = sumRunMs(runs, now)
  const liveDurText = liveRun && LIVE_STATUSES.has(liveRun.status) && liveRun.status !== "paused"
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
          data-task-modal-status={shellMode === "takeover" ? "takeover" : derivedStatus}
          className={`shrink-0 rounded-full border-[1.5px] px-2 py-px text-[10px] font-black ${
            shellMode === "takeover"
              ? TASK_PILL.takeover
              : TASK_PILL[derivedStatus] ?? "border-pop-bd text-pop-dim"
          }`}
        >
          {shellMode === "takeover"
            ? SHELL_MODE_LABEL.takeover
            : derivedStatus === "awaiting_review" && awaitingPv
              ? `◆ 待验收 · P${awaitingPv.index}${takeoverDelivered ? " · 接管件" : ""}`
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
                {/* 票11 页签徽标：消耗=成本$（黄），产物=件数（原型 renderModal cnt）。
                    收口⑥：判据 = manifestTotalCount>0 —— server 空降级恒返五组，
                    groups.length 会让零产物任务谎挂「0」角标。 */}
                {k === "usage" && totalAgg && totalAgg.totalCalls > 0 && (
                  <span className="tabular-nums text-pop-yellow" data-testid="tab-badge-usage">{costText}</span>
                )}
                {k === "artifacts" && manifestTotalCount(manifest ?? { groups: [] }) > 0 && (
                  <span className="tabular-nums opacity-80" data-testid="tab-badge-artifacts">{manifestTotalCount(manifest ?? { groups: [] })}</span>
                )}
              </button>
            ))}
            <FoldMasterChip className="ml-auto" />
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {/* keep-mounted：hidden 切换而非卸载 —— 复检会话/走查 gate/编辑草稿
                活过页签往返；[data-acceptance-modal] 锚点在 surface 内原样。
                ⑪真机复点：host 衬底 = 壳同底 bg-pop-bg（原 bg-pop-paper 亮卡衬底撤 ——
                「✓ 走查」「▶ 日志」与「≡ 变更」「◆ 节点」净黑同框）。 */}
            {acceptMounted && (
              <div data-tab-host="review" className={`min-h-0 flex-1 bg-pop-bg ${tab !== "review" ? "hidden" : ""}`}>
                {/* detail 单源：控制台的 GET /:id 快照 + 重拉通道直接注入；
                    onActionApi = 右栏底部 通过/打回/中止 的接线柱（行为单源在 surface）。
                    railless（票11 ⑩回补）：走查页签不再嵌「摘要+动作/验收进度」内列。 */}
                <AcceptanceSurface
                  task={task}
                  detailOverride={detail}
                  onRefetch={refetch}
                  onMutated={() => { onMutated(); refetch() }}
                  onDecided={() => setTabSel("console")}
                  onActionApi={setAcceptApi}
                  railless
                />
              </div>
            )}
            {tab === "console" && (
              // ⑪真机复点 · 日志铺到底：host = flex 纵向链（min-h-0 + flex-col），
              // 事件流盒 flex-1 撑满到内容区底（原型 m-content>.console{height:100%}）。
              <div data-tab-host="console" className="flex min-h-0 flex-1 flex-col p-3.5">
                {/* 票11 用户终裁 · 日志全纯：控制台/日志页签只挂工作区事件流
                    （agent_events 时间正序，工具/编辑/成败/警告分类行 + ⚑ 人工干预 pink
                    高亮行；实时走既有 executions/events SSE、轮询兜底/首屏）。
                    原叠挂的 Phase/Report 面（门禁/交付报告/轮次账本/盘上文件/大事报/
                    战报瓦片）整体撤场，不另找落点；InterventionStream digest 亦已撤
                    （收口②，票06 testid 转钉流内高亮行）。 */}
                <WorkspaceEventStream events={streamEvents} live={targetLive && isLive} />
              </div>
            )}
            {tab === "usage" && (
              // 票11 ▤ 消耗：既有卡三段（总计/按模型/分轮账本，K/M）升格挂载
              // + 逐节点行 + task-doer 对话单独一行（无对话历史不显 —— usage-model 判据）。
              <div className="min-h-0 flex-1 overflow-y-auto p-3.5" data-tab-host="usage">
                <UsageTab
                  agg={totalAgg} loading={!aggLoaded} runCount={runs.length}
                  rounds={runs.map((r) => ({ key: r.id, label: execLabel(r), agg: aggMap[r.id] ?? null }))}
                  doerSessionId={task.doer_session_id ?? null}
                />
              </div>
            )}
            {tab === "artifacts" && (
              // 票11 ▣ 产物：分组清单（server manifest 端点）+ 预览对话框现读 + 复制路径。
              <div className="min-h-0 flex-1 overflow-y-auto" data-tab-host="artifacts">
                <ArtifactsTab taskId={task.id} body={manifest} loading={manifestLoading && !manifest} />
              </div>
            )}
            {tab === "files" && (
              // 票 03 落地：GitHub Files-changed 视图（统计条/口径切换/行内双行号 diff）。
              // 票 07 接线：rowDecor = 快改文件的 💬chat 徽标；toolbarExtra = 本会话 ×N chip
              // （点击回对话页签）；reveal = 工具卡「查看 diff」跳链的一次性揭示。
              <div className="flex min-h-0 flex-1 flex-col" data-tab-host="files">
                <FilesTab
                  taskId={task.id}
                  feed={diffFeed}
                  serving={filesServing}
                  isLive={isLive}
                  costText={costText}
                  rowDecor={(file) => diffRowHit(file.path, chatEdits.files) ? (
                    <span
                      data-testid="quick-edit-badge"
                      title="task-doer 对话改动（快速修改）—— 提交信息带 [quick-edit] 标记，台账分列"
                      className="ml-1 shrink-0 rounded-md border-[1.5px] border-pop-cyan/45 bg-pop-cyan-soft px-1 py-px font-mono text-[8.5px] font-black text-pop-cyan"
                    >
                      💬 chat
                    </span>
                  ) : null}
                  toolbarExtra={chatEdits.commits > 0 ? (
                    <button
                      data-testid="quick-edit-chip"
                      onClick={() => setTabSel("chat")}
                      title="本会话 task-doer 快速修改（每改 = 一枚 [quick-edit] commit）—— 点击回「💬 对话」"
                      className="rounded-full border-[1.5px] border-pop-cyan/45 bg-pop-cyan-soft px-2 py-px font-mono text-[9.5px] font-black text-pop-cyan"
                    >
                      💬 chat 快改 ×{chatEdits.commits}
                    </button>
                  ) : undefined}
                  reveal={reveal}
                />
              </div>
            )}
            {tab === "nodes" && (
              // 票 04 落地：◆ 节点 —— 绑定执行的只读任务清单（✓/●/⏸/○/⏹ + 类型徽标 +
              // 用时/成本 + 展开事件流含 ⚑ 行）；手术式操作经深链去执行详情视图。
              // takeover/fixing 形态走同一组件（shellMode 由 08 点亮；修复轮按
              // 05 契约从执行行 workflow_ref 自判）。
              // 票07(原型⓬)：ready 且该相位无执行行 → 静态预览（绑定流 YAML 声明序全 ○，
              // 展开=「未执行 · 等待触发」）；触发后 nodesRun 在场自动走下面动态分支。
              <div className="min-h-0 flex-1 overflow-y-auto p-4" data-tab-host="nodes">
                {staticPreview ? (
                  <StaticNodesTab
                    taskId={task.id}
                    workflowRef={staticPreviewPhase?.workflowRef ?? null}
                    phaseIndex={typeof view === "number" ? view : null}
                  />
                ) : (
                  <NodesTab run={nodesRun} mode={shellMode} live={isLive} />
                )}
              </div>
            )}
            {tab === "spec" && (
              // 票07(原型⓬)三签之「▤ 规格」：本票落占位壳，票 09 替换为 SpecPanel
              // 只读镜像（Phases/入队清单/批次树）—— 只换内容不动装配。
              <div className="flex min-h-0 flex-1 flex-col p-3.5" data-tab-host="spec">
                <ReadySpecPlaceholder />
              </div>
            )}
            {tab === "chat" && (
              // 票 07 落地：💬 对话 —— 整屏消息流 + 输入（原型 chatFullHtml）。
              // 三形态同一组件换语义：待验收=快速修改 / 接管（08 点亮）/ 修复轮追加指令。
              // 数据源 = S1 GET/POST /api/tasks/:id/chat；快改徽标经 rowDecor/toolbarExtra 钩子。
              // 票07(原型⓬)：ready 的对话语义不同（草稿期全史**只读回放**，无输入框）——
              // 本票落占位壳，票 08 替换为回放面；三签形态外的 chat（awaiting/接管/修复轮）不动。
              <div className="flex min-h-0 flex-1 flex-col" data-tab-host={tab}>
                {derivedStatus === "ready" ? (
                  <ReadyChatPlaceholder />
                ) : (
                  <TaskChatTab
                    taskId={task.id}
                    form={chatForm ?? "quick-edit"}
                    interventions={interventionRows}
                    takeoverDelivered={takeoverDelivered}
                    openingDraft={openingDraft}
                    onEditsChange={handleEditsChange}
                    onQuickEditCommit={handleQuickEditCommit}
                    onJumpToDiff={handleJumpToDiff}
                    onRejectDraft={handleRejectDraft}
                    onInterventionSend={handleInterventionSend}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右 rail：Pipeline + LIVE/验收卡（滚动） + 底部动作区（钉底） */}
        <aside className="flex w-[296px] shrink-0 min-h-0 flex-col border-l-[1.5px] border-pop-bd bg-pop-idle">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PipelineRail
              task={task} detail={detail} phaseViews={phaseViews}
              now={now} totalAgg={totalAgg} aggLoaded={aggLoaded}
              budgetMs={budgetMs} view={view} onSelect={setSel} isV4={isV4}
            />
            <RailStatusCard
              derivedStatus={derivedStatus}
              shellMode={shellMode}
              liveRun={liveRun}
              awaitingPv={awaitingPv}
              takeoverPv={takeoverPv}
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
                wsUrl={wsViewUrl}
                wsPhase={awaitingPv?.index ?? null}
                handlers={{
                  trigger: () => setTriggerOpen(true),
                  triggerCancel: handleCancelTrigger,
                  reopen: handleReopen,
                  pause: () => { void handlePause() },
                  resume: () => setInjectOpen(true), // 票 06：只开注入弹框，放行在框里
                  wsDeeplink: () => { if (wsViewUrl) window.open(wsViewUrl, "_blank", "noopener") },
                  abort: () => {
                    // 票11 中止归栏：待验收的「■ 中止」= 走查面既有二次确认流
                    // （railless 撤了内列按钮，句柄仍在 —— 行为单源，确认后
                    // handleAbort → abortTask 端点，任务态由服务端定）。
                    // 收口⑦：其余形态（句柄未注册 / 非待验收）不再旁路直落 ——
                    // 兜底路径同样过 ConfirmDialog 单源同款危险确认，确认才打端点。
                    if (derivedStatus === "awaiting_review" && acceptApi?.requestAbort) acceptApi.requestAbort()
                    else setAbortConfirmOpen(true)
                  },
                  duplicate: handleDuplicate,
                  askTakeover: () => { setBranchChoice("inject"); setBranchOpen(true) },
                  deliverTakeover: handleDeliverTakeover,
                  reassignFix: () => { setFixPrefill(""); setFixOpen(true) },
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
      {/* 票 08 · 「✋ 有问题」三分支框 + 改派 task-fix 指令框（Esc 层序同 06 裁决）。 */}
      <TakeoverBranchDialog
        open={branchOpen}
        onOpenChange={setBranchOpen}
        initialChoice={branchChoice}
        busy={busy === "takeover"}
        contextLine={`已跑 ${liveDurText} · 成本 ${costText} · 当前节点「${(liveRun ?? runningRun)?.name || (liveRun ?? runningRun)?.workflow_ref.replace(/^built-in\//, "") || "—"}」`}
        onGo={(choice, note) => { void handleBranchGo(choice, note) }}
      />
      <FixDispatchDialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        prefill={fixPrefill}
        busy={busy === "fix"}
        boundWorkflowLabel={(liveRun ?? runningRun ?? pausedRun)?.name
          || (liveRun ?? runningRun ?? pausedRun)?.workflow_ref.replace(/^built-in\//, "")
          || takeoverPv?.workflowRef.replace(/^built-in\//, "")
          || "绑定工作流"}
        onDispatch={(instruction) => { void handleFixDispatch(instruction) }}
      />
      {/* 票11 收口⑦ · 中止兜底二次确认 —— 与走查面 requestAbort 流同字 ConfirmDialog
          单源组件（危险确认文案一致），确认后走同一 handleAbort。 */}
      <ConfirmDialog
        open={abortConfirmOpen}
        onOpenChange={(o) => { if (!o && busy !== "abort") setAbortConfirmOpen(false) }}
        title={`中止任务「${task.name}」？`}
        description="在跑的复检 / 预览会被一并 SIGTERM；Phase 置 aborted 不可恢复 —— 票与 diff 保留，可整任务重开。"
        confirmLabel="确认中止"
        variant="destructive"
        loading={busy === "abort"}
        onConfirm={() => { setAbortConfirmOpen(false); void handleAbort() }}
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
  /** ⑪四钮定版：待验收「🗂 工作空间 · P<ph> 执行视图 ↗」= deepLinkTarget 同源
   *  URL，window.open 新标签（不顶走弹窗），壳只接线不落端点。 */
  wsDeeplink: () => void
  abort: () => void
  duplicate: () => void
  askTakeover: () => void
  deliverTakeover: () => void
  reassignFix: () => void
}

function RailActionButton({ id, busy, acceptApi, wsUrl, wsPhase, handlers }: {
  id: RailActionId
  busy: TaskRunConsoleBusy
  acceptApi: AcceptanceActionApi | null
  /** 待验收工作空间深链（null = awaiting 轮未落 run → 按钮禁而不藏）。 */
  wsUrl: string | null
  wsPhase: number | null
  handlers: RailActionHandlers
}) {
  const spin = (k: Exclude<TaskRunConsoleBusy, null>) => busy === k ? <Spinner className="mr-1 inline size-3" /> : null
  switch (id) {
    case "trigger":
      return (
        <button onClick={handlers.trigger} disabled={busy !== null} data-task-trigger
          className={`${RAIL_BTN} border-pop-green bg-pop-green text-pop-bg hover:brightness-110`}
          title="打开触发对话框（发射门禁以服务端为准）">
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
          // ⑪四钮定版：红衬底红字（原型 .ab-stop：rgba(255,92,92,.13) 底 + /50 描边，
          // hover 实心）—— 用既有 pop-red token 透明度阶，不造新色。
          className={`${RAIL_BTN} border-pop-red/50 bg-pop-red/10 text-pop-red hover:bg-pop-red hover:text-pop-ink`}
          title="中止任务（工作区将清理）—— 经二次确认才落端点（待验收=走查面句柄，兜底=壳 ConfirmDialog）">
          {spin("abort")}■ 中止任务
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
          title="打开打回反馈框（既有表单与弹窗，行为单源在走查面）—— 恒派 task-fix 修复轮（05 单路径）"
          data-rail-reject
          // ⑪四钮定版：粉衬底粉字（原型 .ab-rej：pink-soft 底 + pink 字 + pink/50 描边）
          className={`${RAIL_BTN} border-pop-pink/50 bg-pop-pink-soft text-pop-pink hover:bg-pop-pink hover:text-pop-bg`}
        >
          ↩ 反馈打回 · task-fix 修复轮（大改）
        </button>
      )
    // ⑪真机复点四钮定版（待验收独有）：工作空间深链 = 当前 Phase 执行视图，
    // 新标签打开（deepLinkTarget 同源 URL），run/takeover/fixing 右栏不装配此钮。
    case "ws-deeplink":
      return (
        <button
          onClick={handlers.wsDeeplink}
          disabled={busy !== null || wsUrl === null}
          title={wsUrl ? "在工作区打开当前 Phase 的执行视图（新标签页 —— 深链单源 deepLinkTarget）" : "待验收轮尚未落执行记录 —— 深链不可得"}
          data-rail-ws
          className={`${RAIL_BTN} border-pop-cyan/50 bg-pop-cyan-soft text-pop-cyan hover:bg-pop-cyan hover:text-pop-bg`}
        >
          🗂 工作空间 · P{wsPhase ?? "?"} 执行视图 ↗
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
    // ── 票08 三分支（02 留位的 ✋ 正主 —— 只许在 rail-acts，04 只读扫描面外）──
    case "ask-takeover":
      return (
        <button onClick={handlers.askTakeover} disabled={busy !== null} data-task-ask-takeover
          title="本 Round 遇到问题？三条路一次选：① 注入干预继续 ② 停流我接管 ③ 改派 task-fix"
          className={`${RAIL_BTN} border-pop-pink/55 bg-pop-pink-soft text-pop-pink hover:bg-pop-pink hover:text-pop-bg`}
        >
          ✋ 有问题？接管本 Round…
        </button>
      )
    case "takeover-deliver":
      return (
        <button onClick={() => void handlers.deliverTakeover()} disabled={busy !== null} data-rail-deliver
          title="接管完成 —— 本 Round 产物带 takeover 标记进入验收 Gate（自动复检未跑，如实入台账）"
          className={`${RAIL_BTN} border-pop-green bg-pop-green text-pop-bg hover:brightness-110`}
        >
          {spin("deliver")}✓ 确认本 Round 交付 · 转待验收
        </button>
      )
    case "takeover-reassign":
      return (
        <button onClick={handlers.reassignFix} disabled={busy !== null} data-rail-reassign
          title="接管中反手改派 —— 写指令派 built-in/task-fix 通用流收尾（快改 commit 不丢，同分支续跑）"
          className={`${RAIL_BTN} border-pop-cyan/50 bg-pop-cyan-soft text-pop-cyan hover:bg-pop-cyan hover:text-pop-bg`}
        >
          {spin("fix")}⚙ 剩余交给 task-fix 通用流
        </button>
      )
  }
}

type TaskRunConsoleBusy = "abort" | "reopen" | "cancel" | "pause" | "resume" | "duplicate" | "takeover" | "deliver" | "fix" | null

// ── LIVE / 验收状态卡（原型 .live-card；⚑ 干预×N = 票 06 注入留痕计数）──────

function RailStatusCard({ derivedStatus, shellMode, liveRun, awaitingPv, takeoverPv, costText, durText, interventions }: {
  derivedStatus: string
  shellMode: ConsoleShellMode
  liveRun: TaskExecutionBadge | null
  awaitingPv: TaskPhaseView | null
  takeoverPv: TaskPhaseView | null
  costText: string
  durText: string
  interventions: InterventionStats
}) {
  const takeover = shellMode === "takeover" && takeoverPv
  const running = !takeover && derivedStatus === "running" && liveRun
  const paused = !takeover && derivedStatus === "paused"
  const awaiting = !takeover && derivedStatus === "awaiting_review" && awaitingPv
  const hd = takeover
    ? `✋ TAKEOVER · P${takeoverPv!.index}·R${takeoverPv!.currentRound ?? 1}`
    : awaiting
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
      <div className={`flex items-center gap-2 px-3 py-1.5 font-mono text-[10px] font-black ${
        takeover ? "bg-pop-pink-soft text-pop-pink" : "bg-pop-purple-soft text-pop-purple"
      }`}>
        {hd}
        <span className="ml-auto tabular-nums text-pop-ink">{durText}</span>
      </div>
      <div className="flex flex-col gap-1 bg-pop-paper px-3 py-2 font-mono text-[10.5px] text-pop-dim">
        {takeover && (
          <>
            <span>工作流已停 · <b className="text-pop-pink">人工接管中</b> —— 「💬 对话接管」一步一交</span>
            <span>变更 <b className="text-pop-ink">≡ 实时进「变更」页签</b> · 满意后点「✓ 确认交付」</span>
          </>
        )}
        {(running || paused) && liveRun && (
          <span>节点 <b className="text-pop-ink">{liveRun.name || liveRun.workflow_ref.replace(/^built-in\//, "")}</b>{liveRun.phase_index != null ? ` · P${liveRun.phase_index}·R${liveRun.round_index ?? 1}` : ""}{interventions.currentNodeCount > 0 && (
            <span className="font-black text-pop-pink" data-testid="rail-intervention-chip"> · ⚑ 干预×{interventions.currentNodeCount}</span>
          )}</span>
        )}
        {awaiting && <span>执行结果 <b className="text-pop-ink">等你放行</b></span>}
        {derivedStatus === "ready" && <span>等触发 · 用下方「⚡ 触发」发射（门禁判定以服务端为准）</span>}
        <span>成本 <b className="text-pop-ink">{costText}</b> / 变更 <b className="text-pop-ink">≡ 见「变更」页签</b></span>
        {paused && <span className="text-pop-amber">暂停中 —— 点下方恢复钮：可注入 ⚑ 干预纠偏，或直接继续</span>}
      </div>
    </div>
  )
}

// ── 右 rail：Phase 流水线（唯一状态位）──────────────────────────────
// 票 02：从左侧搬进右栏（原型 .m-rail 语义）；票 11 钉点 testid 原样保留。

function PipelineRail({ task, detail, phaseViews, now, totalAgg, aggLoaded, budgetMs, view, onSelect, isV4 }: {
  task: Task; detail: TaskDetail | null; phaseViews: TaskPhaseView[]
  now: number; totalAgg: LLMCallAggregates | null; aggLoaded: boolean
  budgetMs: number; view: number | "report"; onSelect: (v: number | "report") => void; isV4: boolean
}) {
  const derived = detail?.derived
  const runs = detail?.executions ?? []
  const { ms: runMs, count: runCount } = sumRunMs(runs, now)

  return (
    <div className="min-h-0 px-2.5 py-2.5" data-testid="phase-timeline" data-run-rail>
      <div className="mb-2 flex items-center gap-1.5 px-0.5 font-mono text-[9.5px] font-black tracking-[.1em] text-pop-dim">
        PIPELINE <b className="text-[13px] text-pop-ink">{isV4 ? phaseViews.length : "1"}</b> {isV4 ? "PHASES" : "LEGACY"}
      </div>

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
        {awaitingLine(phaseViews)}
      </div>
    </div>
  )
}

function awaitingLine(phaseViews: TaskPhaseView[]) {
  const p = phaseViews.find((x) => x.status === "awaiting_review")
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
