// packages/web-app/components/tasks/acceptance/acceptance-surface.tsx
//
// 验收台（2026-10-30 v3 · 原型 acceptance-scene-v2 落地）—— 从「一面板的证据」
// 改成「跟着走的三步」：
//
//   ┌ 左导轨：1 看结果 → 2 试一试 → 3 拍个板 + 本轮快照 + 把关提示
//   ├ 步骤 1：结论横幅（成/败/进行中）+ 改动统计 + 报告自述 + 文件级变更 +
//   │          核对证据（spec × 报告 × 实物，AcMatrixPanel）
//   ├ 步骤 2：试一试（PreviewBar）+ 自动自检（VerifyPanel）+ 运行中的实例
//   ├ 步骤 3：核对清单（PlaybookPanel）+ autoAdvance 提示 + 退回回显
//   └ 常驻决策条（仅第 3 步）：✕ 硬闸拦截 / 退回修改 / 验收通过；中止仍走二次确认
//
// 三步面板常驻挂载、CSS 显隐 —— 勾选/预览/复检的会话态跨步不丢，既有 e2e
// testid（acceptance-modal / col-* / approve / reject / playbook-* …）全部保留。
// 视觉：2026-10-30 起跟随全站净黑终端 TUI（app/acceptance-paper.css）—— 不再
// 是深色工作区里的一张亮纸，窗口壳与内部结构同一套 pop 暗色 token。
//
// 数据权威 = GET /:id 的 derived（票 03/07 唯一真相）—— 本组件只读 phaseViews，
// MUST NOT 重实现派生矩阵。提交走 postAcceptance（409=他处已决/态变 → 重拉；
// 400=表单缺陷）；通过 = 先开验收记录预览（ledger dialog）再提交。
//
// 兼容注记：根锚点沿用 data-acceptance-modal / testid acceptance-modal；三列锚点
// data-acceptance-col-* 原样（railless 形态仍剔除摘要/动作内列）。
//
// 归档只读（2026-10-30 用户）：任务 done/archiving 后本面不消失 —— 复用同一套
// 三步界面回看已验收轮（acceptedRound），动作条整条不渲染、勾选/复检/预览/探针
// 全部冻结；playbook / round-diff 用 ?phase_index&round_index 读历史轮。多 phase
// 时顶部阶段轨道可点切换（默认最后一个已验收 phase）。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ArrowRight, Ban, Bot, CheckCircle2, ChevronLeft, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, AcceptanceVerify, AcceptancePreview, AcceptanceRunbook } from "@octopus/shared"
import {
  PHASE_STATUS_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, TASK_STATUS_EVENT,
  TASK_VERIFY_EVENT, TASK_VERIFY_LOG_EVENT, TASK_PREVIEW_EVENT,
  TASK_ACCEPTANCE_PLAN_EVENT,
} from "@octopus/shared"
import {
  abortTask,
  getTask,
  getBatchTree,
  getHomeFile,
  listHomeDir,
  postAcceptance,
  updateSpecField,
  TaskApiError,
  MAX_HOME_FILE_READ_BYTES,
  getRoundDiff,
  getVerifyStatus,
  startVerify,
  abortVerify,
  getPlaybook,
  startPreview,
  getPreview,
  stopPreview,
  regenerateAcceptancePlan,
  type HomeFileListingEntry,
  type RoundDiffPayload,
  type VerifySummary,
  type VerifyState,
  type PlaybookPayload,
  type PreviewSummary,
  type TaskDetail,
  type TaskPhaseView,
  type TaskRoundView,
} from "@/lib/tasks-api"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { subscribeSSE, subscribeSSEStatus } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { ArtifactViewerDialog, type HomeViewEntry } from "../authoring/artifact-viewer-dialog"
import { batchDirOf } from "../authoring/phase-spec-dialog"
import { isRelativeScratchSpec } from "../authoring/use-batch-tree"
// 票08 接管件判据单源。
import { isTakeoverDeliveredRound } from "./acceptance-labels"
// 票09 台账预览统计口径复用 03 的 files-tab-model（scopeTotals 单源，勿另算）。
import { scopeTotals } from "../files-tab/files-tab-model"
import { VerifyPanel } from "./verify-panel"
import { PreviewBar } from "./preview-bar"
import { InstancesPanel } from "./instances-panel"
import { PlaybookPanel } from "./playbook-panel"
import { AcceptancePlanPanel } from "./acceptance-plan-panel"
import { AcMatrixPanel } from "./ac-matrix-panel"
import { runErrorOf } from "../execution-summary"
import { verifyStateLabel, previewStateLabel } from "./acceptance-labels"
import { ConfirmDialog } from "@/components/scheduler/confirm-dialog"

// ── Props ────────────────────────────────────────────────────────────

/** 票 02 统一壳接线契约：右栏底部「通过/打回」不复制决策逻辑，只拿这组句柄调
 *  本面既有入口（requestAccept 仍走台账预览确认、openReject 仍走反馈弹窗）。
 *  本面自身动作列照旧在场（票 05/07 改版时收口），两处按钮行为单源。 */
export interface AcceptanceActionApi {
  /** = 动作区「验收通过」按钮：gate ✗ 时内部 toast 拦截，否则开台账预览。 */
  requestAccept: () => void
  /** = 动作区「打回（写反馈）」：开反馈弹窗（✗ 票预填照旧）。
   *  draft（票 07）：对话页签「大改劝退 → ↩ 打回」送回的指令草稿 —— 给定时直接
   *  落进单 textarea（草稿即指令，✗ 票预填让位），服务端 augmentReject 仍权威追加未过项。 */
  openReject: (draft?: string) => void
  /** 票11 ⑩回补 = 动作区「■ 中止」：开危险二次确认框（既有 ConfirmDialog 流），
   *  确认后仍走本面 handleAbort → abortTask 端点 —— 壳右栏「中止」钮复用此口，
   *  不新增端点、不新增状态、确认流单源。 */
  requestAbort: () => void
  /** 通过是否被拦（✗ 未决硬闸 / 决策在飞）—— 外层按钮据此置灰。 */
  blocked: boolean
}

export interface AcceptanceSurfaceProps {
  task: Task | null
  /** 看板刷新钩子（决策成功后让外层列表重拉）。 */
  onMutated: () => void
  /** 验收通过 / 中止 后回调（控制台据此切回「执行控制台」tab）。 */
  onDecided?: () => void
  /** detail 单源化（2026-09-20 架构收敛）：嵌在执行控制台里时由父级注入同一份
   *  GET /:id 快照 + 重拉通道，杜绝「modal/console/surface 各持一份互相矛盾」。
   *  undefined = 独立挂载（单测/其他宿主）→ 组件自拉保底。 */
  detailOverride?: TaskDetail | null
  /** 配套 detailOverride 的重拉钩子（409 恢复、spec-field 保存后走它）。 */
  onRefetch?: () => void
  /** 票 02 统一壳：向宿主注册决策入口句柄（右栏底部 通过/打回/中止 的接线柱）。 */
  onActionApi?: (api: AcceptanceActionApi | null) => void
  /** 票 11 ⑩回补：壳内「✓ 走查」页签渲染路径剔除自带右栏（「摘要+动作/验收进度」
   *  内列）—— 决策/中止入口唯一化到壳右栏（经 onActionApi 句柄，行为单源）。
   *  独立挂载（缺省 false）形态零变化。 */
  railless?: boolean
  /** 2026-10-28 M5: the acceptance window no longer renders a diff; this
   *  focuses the dedicated changes window in round scope. */
  onOpenChanges?: () => void
}

const ROUND_STATE_LABEL: Record<string, string> = {
  pending: "排队中", running: "执行中", succeeded: "执行成功",
  failed: "执行失败", cancelled: "已取消/中止",
}

/** 空态稳定引用（勿写成内联 []，见 phaseViews memo 的注释）。 */
const NO_PHASE_VIEWS: TaskPhaseView[] = []

export function AcceptanceSurface({ task, onMutated, onDecided, detailOverride, onRefetch, onActionApi, railless, onOpenChanges }: AcceptanceSurfaceProps) {
  const taskId = task?.id ?? null
  const embedded = detailOverride !== undefined
  const [internalDetail, setInternalDetail] = useState<TaskDetail | null>(null)
  const detail = embedded ? detailOverride : internalDetail
  // 批次目录文件清单 —— 叙述 tab 退役后只剩一个消费方：定位 round-report.md
  // （核对 tab 的「报告声称」源）。null=未载/重载入中，[]=无文件或目录未落盘(404)。
  const [files, setFiles] = useState<HomeFileListingEntry[] | null>(null)
  const [batchReload, setBatchReload] = useState(0) // SSE collect → bump 重拉
  const [homeViewing, setHomeViewing] = useState<HomeViewEntry | null>(null)
  const [roundReport, setRoundReport] = useState<string | null>(null)

  // 打回子块（右列展开）+ 提交后的去向回显（ADR-0024 单路径：恒派 task-fix）。
  // 2026-10-30 验收台 v3（原型 v2 落地）：三步走 —— 看结果 / 试一试 / 拍个板。
  // 所有步骤面板常驻挂载（CSS 显隐）—— 勾选/预览/复检的会话状态跨步不丢，
  // 也保证既有 testid 在任意步骤都能被定位。
  const [step, setStep] = useState(1)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [busy, setBusy] = useState<"accept" | "reject" | "abort" | null>(null)
  const [rejectedSeam, setRejectedSeam] = useState<{ phaseIndex: number; roundIndex: number; feedback: string } | null>(null)
  // specPath 绝对/缺失（gateV4 容忍 agent 旁路直写）时的批次定位回退位：
  // getBatchTree 按 slug 取 latest_mtime 最新 dir（specPath 优先,正常 v4 恒命中）。
  const [fallbackDir, setFallbackDir] = useState<string | null>(null)
  // ── 验货台 (acceptance v2) 状态 ──
  // 2026-10-28 M5: the diff moved to its own window; this surface keeps the
  // roundDiff DATA (the AC matrix cross-checks report claims against it) but
  // no longer renders a 实物 tab.
  const [roundDiff, setRoundDiff] = useState<RoundDiffPayload | null>(null)
  const [specMd, setSpecMd] = useState<string | null>(null) // 核对 tab 懒拉;"" = 不存在
  const [specLoading, setSpecLoading] = useState(false)
  // 懒拉 once 门（改版修正）：旧实现把 specLoading 放进 effect deps，
  // setSpecLoading(true) 触发 effect 自重跑 → cleanup 抢在响应前把首轮
  // cancelled=true → 两形皆空,核对 tab 永转「读取契约结构…」。ref 门不进
  // deps，竞态根除；换任务/换批次才重置。
  const specFetchedForRef = useRef<string | null>(null)
  const [verify, setVerify] = useState<VerifySummary | null>(null)
  const [verifyLines, setVerifyLines] = useState<string[]>([])
  // 本次复检会话已收行数（SSE 流 1:1 计数，与窗口 cap 无关）—— 断线重连时作
  // GET /:id/verify?since=n 的游标，只补缺口不重搬全量（server S5）。
  const verifySeenRef = useRef(0)
  const [verifyBusy, setVerifyBusy] = useState(false)
  // ── 验收面 v2.1 状态：剧本 + 预览 + 决策确认层 ──
  const [playbook, setPlaybook] = useState<PlaybookPayload | null>(null)
  /** 方案生成完成 / SSE 到达 → 加一，触发重拉 playbook（plan 优先）。 */
  const [playbookNonce, setPlaybookNonce] = useState(0)
  const [gate, setGate] = useState<{ pass: number; fail: number; skip: number; undecided: number; total: number; failTickets: string[] }>({ pass: 0, fail: 0, skip: 0, undecided: 0, total: 0, failTickets: [] })
  const [checksSaving, setChecksSaving] = useState(false)
  const [preview, setPreview] = useState<PreviewSummary | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)   // 通过 = ledger 预览确认弹层
  const [abortOpen, setAbortOpen] = useState(false)      // 中止 = 危险确认
  // 竞态闸（A1/C1）：决策 POST 前把 debounce 窗里的最后一笔勾选 flush 落盘 ——
  // server 硬闸与台账读的都是 acceptance-checks 盘上文件，屏幕真相必须已进盘。
  const playbookFlushRef = useRef<(() => Promise<void>) | null>(null)
  const registerPlaybookFlush = useCallback((fn: (() => Promise<void>) | null) => { playbookFlushRef.current = fn }, [])

  const refetchDetail = useCallback(() => {
    if (!taskId) return
    if (embedded) { onRefetch?.(); return }
    getTask(taskId).then(setInternalDetail).catch(() => { /* keep last snapshot */ })
  }, [taskId, embedded, onRefetch])

  // 挂载/taskId 变化：拉 detail（独立挂载时）+ 复位打回子块与验货台缓存。
  // 嵌入态 detail 归父级（控制台）所有，这里只清自己的会话缓存。
  useEffect(() => {
    if (!taskId) return
    if (!embedded) setInternalDetail(null)
    setStep(1)
    setRejectOpen(false)
    setFeedback("")
    setRejectedSeam(null)
    setFiles(null)
    setRoundReport(null)
    setFallbackDir(null)
    setRoundDiff(null)
    setFixReportMd(null)
    setSpecMd(null)
    specFetchedForRef.current = null
    setVerify(null)
    setVerifyLines([])
    verifySeenRef.current = 0
    setPlaybook(null)
    setGate({ pass: 0, fail: 0, skip: 0, undecided: 0, total: 0, failTickets: [] })
    setPreview(null)
    setLedgerOpen(false)
    setAbortOpen(false)
    if (!embedded) refetchDetail()
  }, [taskId, embedded, refetchDetail])

  // SSE 挂面（K14「无需刷新」）：phase_status_update / task_status → 重拉派生
  // （嵌入态由控制台代拉 —— detail 单源，一份事件只发一次 GET）；
  // task_artifacts_update → 重拉批次列表（票 06 collect 轮终态上行即推 — 中列
  // 的证据就是这个事件带回来的）。
  useEffect(() => {
    if (!taskId) return
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (e: MessageEvent): boolean => {
      try {
        return (JSON.parse(e.data) as { task_id?: string }).task_id === taskId
      } catch {
        return false
      }
    }
    const unPhase = embedded ? () => {} : subscribeSSE(url, PHASE_STATUS_UPDATE_EVENT, (e) => { if (mine(e)) refetchDetail() })
    const unStatus = embedded ? () => {} : subscribeSSE(url, TASK_STATUS_EVENT, (e) => { if (mine(e)) refetchDetail() })
    const unArts = subscribeSSE(url, TASK_ARTIFACTS_UPDATE_EVENT, (e) => { if (mine(e)) setBatchReload((v) => v + 1) })
    // 验收方案生成状态（2026-10-30）：ready/failed 都重拉 playbook —— ready 时
    // 第三步切换到方案面板，failed 时显示诚实降级条。面板未挂载时也靠这里。
    const unPlan = subscribeSSE(url, TASK_ACCEPTANCE_PLAN_EVENT, (e) => {
      if (mine(e)) setPlaybookNonce((v) => v + 1)
    })
    // 验货台复检：逐行进控制台（client cap 2000；重连由 GET /:id/verify tail 兜底），
    // 终态合并进 summary（stamp/verdict 指针都读 summary.state，不另设标志位）。
    const unVLog = subscribeSSE(url, TASK_VERIFY_LOG_EVENT, (e) => {
      if (!mine(e)) return
      try {
        const d = JSON.parse(e.data) as { line?: string; stream?: string }
        if (typeof d.line !== "string") return
        const line = d.stream === "stderr" ? `[stderr] ${d.line}` : d.line
        verifySeenRef.current++
        setVerifyLines((prev) => (prev.length > 2000 ? [...prev.slice(prev.length - 2000), line] : [...prev, line]))
      } catch { /* malformed frame — drop */ }
    })
    const unVerify = subscribeSSE(url, TASK_VERIFY_EVENT, (e) => {
      if (!mine(e)) return
      try {
        const d = JSON.parse(e.data) as {
          state?: VerifyState; exit_code?: number; duration_ms?: number; verdict_path?: string | null
        }
        setVerify((prev) => (prev ? { ...prev, ...d } : prev))
      } catch { /* drop */ }
    })
    // 预览状态流转（starting→ready→stopped/exited）；终态不静默。
    const unPreview = subscribeSSE(url, TASK_PREVIEW_EVENT, (e) => {
      if (!mine(e)) return
      try {
        const d = JSON.parse(e.data) as Partial<PreviewSummary> & { task_id: string }
        setPreview((prev) => (prev ? { ...prev, ...d } : prev))
      } catch { /* drop */ }
    })
    return () => { unPhase(); unStatus(); unArts(); unVLog(); unVerify(); unPreview(); unPlan() }
  }, [taskId, refetchDetail])

  // ── 连接可见性（2026-09-20：断线静默失真比缺功能更致命）──
  // 旧 EventSource 掉线后盘面停在旧快照且「看起来是活的」。现在：断线顶条挂
  // 「连接中断 · 数据截至 HH:MM:SS」（截的正是失联那一刻），重连（浏览器自愈或
  // sse-manager 手动重建）即补拉一遍：detail / 批次清单 / verify 会话 / preview。
  // verify 尾窗用服务端 tail 整体替换 —— 宁可短且无缺口，不要长但中段丢行。
  const [sseDown, setSseDown] = useState(false)
  const [sseDownAt, setSseDownAt] = useState<string | null>(null)
  useEffect(() => {
    if (!taskId) return
    const url = `${getServerUrl()}/api/tasks/events`
    let everDown = false
    return subscribeSSEStatus(url, (s) => {
      if (!s.connected) {
        everDown = true
        setSseDown(true)
        setSseDownAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }))
        return
      }
      setSseDown(false)
      setSseDownAt(null)
      if (s.reconnected || everDown) {
        everDown = false
        refetchDetail()
        setBatchReload((v) => v + 1)
        // 断线期间的日志缺口用 since 游标补拉（server S5：lines_after 与 SSE 流
        // 1:1 对齐；未见过任何行时 since=0 = 全量重建，尾部撞 ring 上限即止）。
        getVerifyStatus(taskId, verifySeenRef.current)
          .then((sv) => {
            if (!sv) return
            setVerify((prev) => (prev ? { ...prev, ...sv } : sv))
            const after = sv.lines_after
            if (after?.length) {
              const append = verifySeenRef.current > 0
              verifySeenRef.current += after.length
              setVerifyLines((prev) => {
                const merged = append ? [...prev, ...after] : after
                return merged.length > 2000 ? merged.slice(merged.length - 2000) : merged
              })
            } else if (sv.tail?.length && verifySeenRef.current === 0) {
              setVerifyLines(sv.tail)
            }
          })
          .catch(() => { /* 未装配/老 server — 保持现状，横幅已尽告知义务 */ })
        getPreview(taskId)
          .then((sp) => { if (sp) setPreview((prev) => (prev ? { ...prev, ...sp } : sp)) })
          .catch(() => { /* same */ })
      }
    })
  }, [taskId, refetchDetail])

  // ── 派生视图（票 03 唯一真相，只读不重算） ──
  // 空态用同一个常量引用：detail 未到时若每次返回新 []，下游 memo 会每次渲染
  // 都判「变了」（复审 2026-10-30）。
  const phaseViews = useMemo<TaskPhaseView[]>(
    () => detail?.derived?.phaseViews ?? NO_PHASE_VIEWS,
    [detail],
  )
  const awaitingPhaseRaw: TaskPhaseView | null = useMemo(
    () => phaseViews.find((p) => p.status === "awaiting_review" && p.awaitingRound !== null) ?? null,
    [phaseViews],
  )
  // ── 归档后只读回看（2026-10-30 用户）：任务结束后验收窗不消失 —— 复用同一套
  //    三步界面，只是把「待验收轮」换成已验收轮；动作全部冻结、无决策按钮。
  //    多 phase 的关键：默认停在最后一个已验收 phase，顶部阶段轨道可点切换，
  //    每个 phase 各自回看自己的 acceptedRound（各自的 diff / 剧本 / checks）。
  const acceptedPhases = useMemo(
    () => phaseViews.filter((p) => p.acceptedRound != null),
    [phaseViews],
  )
  const [readOnlyPhasePick, setReadOnlyPhasePick] = useState<number | null>(null)
  useEffect(() => { setReadOnlyPhasePick(null) }, [taskId])
  const readOnlyEligible = ["done", "failed", "aborted", "archiving"].includes(task?.status ?? "")
  const readOnlyPhase: TaskPhaseView | null = useMemo(() => {
    if (awaitingPhaseRaw || !readOnlyEligible) return null
    const picked = readOnlyPhasePick != null
      ? acceptedPhases.find((p) => p.index === readOnlyPhasePick) ?? null
      : null
    return picked ?? acceptedPhases[acceptedPhases.length - 1] ?? null
  }, [awaitingPhaseRaw, readOnlyEligible, acceptedPhases, readOnlyPhasePick])
  const readOnly = !awaitingPhaseRaw && !!readOnlyPhase
  const awaitingPhase: TaskPhaseView | null = awaitingPhaseRaw ?? readOnlyPhase
  /** 待验收轮 = awaitingRound；归档只读回看 = acceptedRound。 */
  const reviewRoundIndex = awaitingPhase?.awaitingRound ?? awaitingPhase?.acceptedRound ?? null
  const awaitingRound: TaskRoundView | null = useMemo(() => {
    if (!awaitingPhase || reviewRoundIndex == null) return null
    return awaitingPhase.rounds.find((r) => r.roundIndex === reviewRoundIndex) ?? null
  }, [awaitingPhase, reviewRoundIndex])
  /** 历史轮只读查询坐标（playbook / round-diff 端点的 ?phase_index&round_index）。 */
  const readOnlyTarget = readOnly && awaitingPhase && reviewRoundIndex != null
    ? { phaseIndex: awaitingPhase.index, roundIndex: reviewRoundIndex }
    : undefined

  // 只读切换 phase：复检/预览是 task 级内存会话，不能串台到别的 phase ——
  // 切 phase 先清空，再由下面的拉取按本轮 exec 重新对上。
  useEffect(() => {
    if (!readOnly) return
    setVerify(null)
    setVerifyLines([])
    verifySeenRef.current = 0
    setPreview(null)
  }, [readOnly, readOnlyPhasePick])

  // ── 验收面 v2.1：剧本编译 + 预览会话恢复 ──
  // playbook：按 await（或归档只读回看的历史轮）现拉；409/无轮 → null 静默。
  // preview：挂载 GET 一次（SSE 无 replay；external 探活由 server 兜）。execId 换轮即重拉。
  useEffect(() => {
    if (!taskId || !awaitingRound) { setPlaybook(null); return }
    let cancelled = false
    getPlaybook(taskId, readOnlyTarget)
      .then((p) => { if (!cancelled) setPlaybook(p) })
      .catch(() => { if (!cancelled) setPlaybook(null) })
    return () => { cancelled = true }
    // readOnlyTarget 是每渲染新建的对象 —— 用它的原始值进 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, awaitingRound?.exec.id, playbookNonce, readOnlyTarget?.phaseIndex, readOnlyTarget?.roundIndex])

  useEffect(() => {
    if (!taskId || !awaitingRound) return
    let cancelled = false
    getPreview(taskId)
      .then((s) => {
        if (cancelled || !s) return
        // 只读回看：预览会话是 task 级，只认本轮 exec（换 phase 不串台）。
        if (readOnly && s.execution_id && s.execution_id !== awaitingRound.exec.id) return
        setPreview(s)
      })
      .catch(() => { /* not wired / offline */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, awaitingRound?.exec.id, readOnly])

  // 本轮 run：executions[] 与本 round 的 exec.id 联查（derived 无 completed_at；票03 起
  // 徽章自带 started_at/completed_at，duration 自己算；票05 起徽章带 error_summary）。
  const roundRun = useMemo(
    () => (awaitingRound ? detail?.executions?.find((e) => e.id === awaitingRound.exec.id) ?? null : null),
    [awaitingRound, detail],
  )
  const durationMs: number | null = useMemo(() => {
    if (!roundRun?.completed_at) return null
    const startMs = roundRun.started_at ? Date.parse(roundRun.started_at) : Date.parse(roundRun.created_at)
    if (Number.isNaN(startMs)) return null
    return Math.max(0, Date.parse(roundRun.completed_at) - startMs)
  }, [roundRun])

  // 该轮为什么红（票05）：验收者面对 failed round 时缺的就是这一行 —— 数据源是
  // executions[] 联查到的徽章 error_summary，按红状态门控（runErrorOf），不臆造拉取。
  const roundError = awaitingRound?.state === "failed" && roundRun ? runErrorOf(roundRun) : null

  // 票08 接管件标注（走查页签「如实显示且不拦通过」）：判据 = 待验收轮的 badge
  // 带 takeover_at + takeover_delivered_at（服务端 exec 行两列经 wire 透出，
  // 单源判定函数 = 07 chat-model::isTakeoverDeliveredRound）。呈现两笔：
  // 头部粉 chip + 「自动复检」行写明未跑。纯只读 —— gate/blocked/硬闸逻辑零触碰
  // （AC5：既有 ✗ 硬闸行为逐字不变，接管件不加任何新闸）。
  const isTakeoverArtifact = isTakeoverDeliveredRound(roundRun ?? undefined)

  // 票09 台账预览统计口径 = 03 files-tab-model::scopeTotals 单源（勿另算，与走查页同源）。
  const diffStats = useMemo(() => scopeTotals(roundDiff), [roundDiff])

  // 步骤 1「改了什么」：按 churn 排序的实文件行（只取前 6，其余折成一行计数）。
  // 数据源与变更窗/台账同源（RoundDiffPayload），不另算口径。
  const diffFiles = useMemo(() => {
    if (!roundDiff?.available) return [] as Array<{ path: string; adds: number; dels: number; repo: string }>
    return roundDiff.repos
      .filter((r) => !r.expired)
      .flatMap((r) => r.groups.flatMap((g) => g.files.map((f) => ({ path: f.path, adds: f.adds, dels: f.dels, repo: r.name }))))
      .sort((a, b) => b.adds + b.dels - (a.adds + a.dels))
  }, [roundDiff])
  const topFiles = diffFiles.slice(0, 6)
  const restFiles = diffFiles.slice(6)
  const restAdds = restFiles.reduce((n, f) => n + f.adds, 0)
  const restDels = restFiles.reduce((n, f) => n + f.dels, 0)
  // 「它做了什么」的直读源 = 本轮 round-report 的「主要改动」子弹列表
  // （agent 自述，逐条可回溯；没有就退回阶段目标，绝不编摘要）。
  const reportHighlights = useMemo(() => extractReportHighlights(roundReport), [roundReport])

  // ── 中列证据面：本 phase 批次目录直读（盘上真相,登记语义已退役） ──────────
  // 定位：specPath 优先（server 权威 phaseSpecDir = dirname(specPath),同语义零
  // 歧义）；绝对/缺失才回退 batch-tree 的 slug 匹配。列表 listHomeDir(all=1)
  // 收全文件（e2e-data/*.txt、probe/*.json 也是证据）；SSE batchReload 重拉。
  const awaitingSpec = useMemo(() => {
    const phases = (detail?.task_spec ?? task?.task_spec)?.phases
    return awaitingPhase ? phases?.find((p) => p.index === awaitingPhase.index) ?? null : null
  }, [detail, task, awaitingPhase])
  const specBatchDir = useMemo(
    () => (awaitingSpec?.specPath && isRelativeScratchSpec(awaitingSpec.specPath)
      ? batchDirOf(awaitingSpec.specPath) || null
      : null),
    [awaitingSpec],
  )
  useEffect(() => {
    if (!taskId || !awaitingPhase || specBatchDir) { setFallbackDir(null); return }
    let cancelled = false
    getBatchTree(taskId)
      .then((bs) => {
        if (cancelled) return
        const hit = bs
          .filter((b) => b.slug === awaitingPhase.slug)
          .sort((a, b) => (a.latest_mtime < b.latest_mtime ? 1 : a.latest_mtime > b.latest_mtime ? -1 : 0))[0]
        setFallbackDir(hit?.dir ?? null)
      })
      .catch(() => { if (!cancelled) setFallbackDir(null) })
    return () => { cancelled = true }
  }, [taskId, awaitingPhase, specBatchDir])
  const batchDir = specBatchDir ?? fallbackDir

  useEffect(() => {
    if (!taskId || !batchDir) return
    let cancelled = false
    setFiles(null)
    listHomeDir(taskId, batchDir, { all: true })
      .then((fs) => { if (!cancelled) setFiles(fs) })
      // 目录未落盘（首轮 collect 前）或读失败 = 同一空态：核对 tab 自会诚实降级
      // （round-report 缺席 → 对账缺一角），叙述 tab 时代的一行显式错误已无处安放。
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [taskId, batchDir, batchReload])

  // 内嵌 round-report 拉取（核对 tab 的「报告声称」源）：固定文件名、每轮覆写
  // （task-author SKILL 约定）。mtime 进 deps → collect 覆写后自动重拉。
  const reportFile = useMemo(
    () => (files ?? []).find((f) => (f.path.split("/").pop() ?? "").toLowerCase() === "round-report.md") ?? null,
    [files],
  )
  useEffect(() => {
    if (!taskId || !reportFile || reportFile.bytes > MAX_HOME_FILE_READ_BYTES) { setRoundReport(null); return }
    let cancelled = false
    getHomeFile(taskId, reportFile.path)
      .then((r) => { if (!cancelled) setRoundReport(r.content) })
      .catch(() => { if (!cancelled) setRoundReport(null) })
    return () => { cancelled = true }
  }, [taskId, reportFile?.path, reportFile?.mtime, reportFile?.bytes])

  // ── 验货台数据流（acceptance v2） ──────────────────────────────────────
  // 实物 diff：按 awaiting 轮现拉（服务端解析 commit 区间；409 无 awaiting = 静默
  // null —— 面板本身有 idle 态）。exec id 变化（换轮/重开）即重拉。
  const awaitingExecId = awaitingRound?.exec.id ?? ""
  useEffect(() => {
    if (!taskId || !awaitingExecId) { setRoundDiff(null); return }
    let cancelled = false
    getRoundDiff(taskId, "round", readOnlyTarget)
      .then((d) => { if (!cancelled) setRoundDiff(d) })
      .catch(() => { if (!cancelled) setRoundDiff(null) })
    return () => { cancelled = true }
    // readOnlyTarget 每渲染新建 —— 按原始值进 deps（同 playbook effect）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, awaitingExecId, readOnlyTarget?.phaseIndex, readOnlyTarget?.roundIndex])

  // ── 打回→修复 回应对账（B 档）：round R 为修复轮时，批次目录成对存在
  // fix-feedback-r{R-1}.md / fix-report-r{R-1}.md（task-fix SKILL：N=被打回轮，
  // 成对可追溯）。report 三列表逐行 × 本轮实物 diff → 幻影回应在核对 tab 现形。
  const fixPairRound = Math.max(0, (awaitingRound?.roundIndex ?? 1) - 1)
  const fixByName = useCallback((name: string) => (fixPairRound >= 1
    ? (files ?? []).find((f) => (f.path.split("/").pop() ?? "").toLowerCase() === `${name}-r${fixPairRound}.md`) ?? null
    : null), [files, fixPairRound])
  const fixReportFile = useMemo(() => fixByName("fix-report"), [fixByName])
  const fixFeedbackFile = useMemo(() => fixByName("fix-feedback"), [fixByName])
  const [fixReportMd, setFixReportMd] = useState<string | null>(null)
  useEffect(() => {
    if (!taskId || !fixReportFile || fixReportFile.bytes > MAX_HOME_FILE_READ_BYTES) { setFixReportMd(null); return }
    let cancelled = false
    getHomeFile(taskId, fixReportFile.path)
      .then((r) => { if (!cancelled) setFixReportMd(r.content) })
      .catch(() => { if (!cancelled) setFixReportMd(null) })
    return () => { cancelled = true }
  }, [taskId, fixReportFile?.path, fixReportFile?.mtime, fixReportFile?.bytes])

  // 复检会话恢复：挂载 GET 一次（SSE 无 replay，tail 由 GET 承载；501/离线 = null）。
  useEffect(() => {
    if (!taskId || !awaitingExecId) return
    let cancelled = false
    getVerifyStatus(taskId)
      .then((s) => {
        if (cancelled || !s) return
        // 只读回看：复检会话是 task 级内存，只认本轮 exec（换 phase 不串台）。
        if (readOnly && s.execution_id && s.execution_id !== awaitingExecId) return
        setVerify(s)
        if (s.tail?.length) setVerifyLines(s.tail)
      })
      .catch(() => { /* 未装配/离线 — 无会话可恢复 */ })
    return () => { cancelled = true }
  }, [taskId, awaitingExecId, readOnly])

  // 核对面的 spec.md：首访懒拉，"" 缓存「不存在」防重拉风暴。once 门走 ref
  // （不进 deps → 不会被 setSpecLoading 自己的重跑掐死,见声明处注释）。
  useEffect(() => {
    if (!taskId || !batchDir) return
    if (specFetchedForRef.current === `${taskId}:${batchDir}`) return
    specFetchedForRef.current = `${taskId}:${batchDir}`
    let cancelled = false
    setSpecLoading(true)
    getHomeFile(taskId, `${batchDir}/spec.md`)
      .then((r) => { if (!cancelled) setSpecMd(r.content) })
      .catch(() => {
        if (cancelled) return
        specFetchedForRef.current = null // 失败可重试（别把 404 之外的抖动缓存成不存在）
        setSpecMd("")
      })
      .finally(() => { if (!cancelled) setSpecLoading(false) })
    return () => { cancelled = true }
  }, [taskId, batchDir])

  const verifyCfg = (detail?.task_spec ?? task?.task_spec)?.acceptance_verify ?? null
  const verifyRunning = verify?.state === "running"
  const wsGone = roundDiff !== null && !roundDiff.available && roundDiff.reason === "no_workspace"
  /** 归档只读：勾选/复检/预览/探针全部冻结（历史数据照常展示）。 */
  const readOnlyReason = readOnly
    ? "已归档 · 只读 — 验收已冻结（记录可查，勾选与运行不可再动）"
    : undefined
  const verifyDisabled = readOnlyReason
    ?? (wsGone ? "工作区目录已不在 — 当场复检不可用（历史输出/verdict 仍可看）" : undefined)

  const handleVerifyRun = useCallback(async () => {
    if (!taskId) return
    setVerifyBusy(true)
    try {
      const s = await startVerify(taskId)
      setVerify(s)
      setVerifyLines([])
      verifySeenRef.current = 0
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "复检启动失败")
    } finally {
      setVerifyBusy(false)
    }
  }, [taskId])

  const handleVerifyAbort = useCallback(async () => {
    if (!taskId) return
    setVerifyBusy(true)
    try {
      const s = await abortVerify(taskId)
      setVerify((prev) => (prev ? { ...prev, ...s } : s))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
    } finally {
      setVerifyBusy(false)
    }
  }, [taskId])

  /** spec-field 持久化（awaiting_review 编辑合法，v4 冻结线在 done/aborted/archiving）。 */
  const handleVerifySave = useCallback(async (v: AcceptanceVerify | null): Promise<boolean> => {
    if (!taskId) return false
    try {
      await updateSpecField(taskId, "acceptance_verify", v, { source: "user" })
      refetchDetail()
      toast.success(v ? "复检命令已保存 — 随任务持久化，下个 phase 也用它" : "复检命令已清除")
      return true
    } catch (err: unknown) {
      toast.error(err instanceof Error ? `保存失败：${err.message}` : "保存失败")
      return false
    }
  }, [taskId, refetchDetail])

  // ── 跑起来看（preview） handlers ──
  const previewCfg = (detail?.task_spec ?? task?.task_spec)?.acceptance_preview ?? null
  // runbook 优先于简写（与 server resolveRunbook 同一裁判）：有它面板就走多服务态。
  const runbookCfg = (detail?.task_spec ?? task?.task_spec)?.acceptance_runbook ?? null

  const handlePreviewStart = useCallback(async () => {
    if (!taskId) return
    setPreviewBusy(true)
    try {
      const s = await startPreview(taskId)
      setPreview(s)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "预览启动失败")
    } finally {
      setPreviewBusy(false)
    }
  }, [taskId])

  const handlePreviewStop = useCallback(async () => {
    if (!taskId) return
    setPreviewBusy(true)
    try {
      const s = await stopPreview(taskId)
      setPreview((prev) => (prev ? { ...prev, ...s } : s))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "停止失败")
    } finally {
      setPreviewBusy(false)
    }
  }, [taskId])

  const handlePreviewSave = useCallback(async (v: AcceptancePreview | null): Promise<boolean> => {
    if (!taskId) return false
    try {
      await updateSpecField(taskId, "acceptance_preview", v, { source: "user" })
      refetchDetail()
      toast.success(v ? "预览配置已保存 — 随任务持久化，下个 phase 复用" : "预览配置已清除")
      return true
    } catch (err: unknown) {
      toast.error(err instanceof Error ? `保存失败：${err.message}` : "保存失败")
      return false
    }
  }, [taskId, refetchDetail])

  const handleRunbookSave = useCallback(async (v: AcceptanceRunbook | null): Promise<boolean> => {
    if (!taskId) return false
    try {
      await updateSpecField(taskId, "acceptance_runbook", v, { source: "user" })
      refetchDetail()
      toast.success(v ? "runbook 已保存 — 起→就绪判据→入口→收尾，随任务持久化" : "runbook 已清除")
      return true
    } catch (err: unknown) {
      toast.error(err instanceof Error ? `保存失败：${err.message}` : "保存失败")
      return false
    }
  }, [taskId, refetchDetail])
  // decision=accepted 语境（确认按钮上方）∧ 存在下一 phase → 一行提示：
  // 本 phase handoff.md 连同已 accepted 前序，accepted 时由 server 作
  // prev_handoff_paths 自动注入下一 phase 执行会话。数据源 = phaseViews
  // 既有派生态（acceptedRound!==null ⇔ status="accepted"，无新 API）。
  // N = 已 accepted 前序数 + 1（含本 phase）；末 phase（无下一站）不显示；
  // 打回面板展开（rejected 态）不显示。
  // ⚠️ 口径注记（review S1）：N 是**账本数**（acceptedRound!==null），不过 fs
  // 存在性；server 注入侧（tasks-service collectPrevHandoffPaths）另按
  // handoff.md isFile 过滤——ship 崩溃轮（R2）实际注入数可能比 N 少 1。
  // 两口径有意分工：账本=人的决策真相，fs=机器注入真相；漂移在 SKILL/ADR-0019 有注记。
  const hasNextPhase = useMemo(() => {
    if (!awaitingPhase) return false
    const pos = phaseViews.findIndex((p) => p.index === awaitingPhase.index)
    return pos >= 0 && pos + 1 < phaseViews.length
  }, [awaitingPhase, phaseViews])

  const handoffCount = useMemo(() => {
    if (!awaitingPhase) return 0
    return phaseViews.filter(
      (p) => p.index < awaitingPhase.index && p.acceptedRound !== null,
    ).length + 1
  }, [awaitingPhase, phaseViews])

  // ── 动作 ──────────────────────────────────────────────────────────

  // 决策：通过 = 先开 ledger 预览确认弹层（唯一入口，D7/D8），确认后才 postAcceptance。
  const requestAccept = useCallback(() => {
    if (busy || readOnly) return
    if (gate.fail > 0) { toast.error("存在 ✗ 未过项 —— 通过被拦，请改走打回（反馈已预填）"); return }
    setLedgerOpen(true)
  }, [busy, readOnly, gate.fail])

  const doAccept = useCallback(async () => {
    if (!task || !awaitingPhase || awaitingPhase.awaitingRound == null || busy) return
    setLedgerOpen(false)
    setBusy("accept")
    try {
      await playbookFlushRef.current?.()
      const result = await postAcceptance(task.id, {
        phase_index: awaitingPhase.index,
        round_index: awaitingPhase.awaitingRound,
        decision: "accepted",
      })
      onMutated()
      const n = result.task.derived?.phaseViews.length ?? phaseViews.length
      // 台账诚实化（A6）：server 机写 ledger 是决策后的 best-effort，写失败/定位不到
      // 批次目录时不再谎报「台账已写」—— 由响应体 ledger_written 承载真相（票 07 契约扩展）。
      const ledgerNote = result.ledger_written === false ? "⚠ 台账写入失败，请手动补记批次目录" : "台账已写"
      switch (result.next_action) {
        case "archiving":
          toast.success(`末 Phase 已通过 — ${ledgerNote}，归档编排中（全绿才 done）`)
          break
        case "awaiting_manual_trigger":
          toast.success(`Phase ${awaitingPhase.index}/${n} 已通过（${ledgerNote}）— autoAdvance 关闭，下一 Phase 停在你的 gate`)
          break
        default:
          toast.success(`Phase ${awaitingPhase.index}/${n} 已通过（${ledgerNote}）— 下一 Phase 已自动开跑`)
      }
      setPreview((prev) => (prev && prev.state !== "stopped" && prev.state !== "exited" ? { ...prev, state: "stopped" } : prev))
      onDecided?.()
    } catch (err: unknown) {
      if (err instanceof TaskApiError && err.status === 409) {
        // 他处已决 / 派生态已变 → 重拉 derived 刷新盘面（票 07 契约）。
        toast.error(`${err.message}（已刷新最新状态）`)
        refetchDetail()
      } else {
        toast.error(err instanceof Error ? err.message : "验收提交失败")
      }
    } finally {
      setBusy(null)
    }
  }, [task, awaitingPhase, busy, onMutated, onDecided, phaseViews.length, refetchDetail])

  // 打回：开弹窗即预填 ✗ 票清单（详细「未过项」节由 server augmentReject 权威追加）。
  // 票 07：对话页签送回劝退草稿时，草稿直接成文（✗ 票预填让位 —— 未过项仍由
  // augmentReject 在提交侧补齐，两不吞）。
  const openReject = useCallback((draft?: string) => {
    if (busy || readOnly) return
    const d = typeof draft === "string" ? draft.trim() : ""
    if (d) {
      setFeedback(`（来自快速修改对话的升级建议）\n${d}\n`)
    } else if (!feedback.trim() && gate.failTickets.length) {
      setFeedback(`未过（验收台剧本 ✗）：\n${gate.failTickets.map((t) => `- ${t}`).join("\n")}\n\n补充：\n`)
    }
    setRejectOpen(true)
  }, [busy, readOnly, feedback, gate.failTickets])

  const handleReject = useCallback(async () => {
    const trimmed = feedback.trim()
    if (!task || !awaitingPhase || awaitingPhase.awaitingRound == null || !trimmed || busy) return
    setBusy("reject")
    try {
      await playbookFlushRef.current?.()
      const result = await postAcceptance(task.id, {
        phase_index: awaitingPhase.index,
        round_index: awaitingPhase.awaitingRound,
        decision: "rejected",
        feedback: trimmed,
        ...(gate.failTickets.length ? { reopen_tickets: gate.failTickets } : {}), // ADR-0022 ✗→票重开
      })
      setRejectedSeam({
        phaseIndex: awaitingPhase.index,
        roundIndex: awaitingPhase.awaitingRound,
        feedback: trimmed,
      })
      setRejectOpen(false)
      setFeedback("")
      onMutated()
      // server 已写 fix-feedback-rN.md 并恒派 task-fix 修复轮即时开跑
      //（ADR-0024 打回单路径 —— 反馈即修复指令，绑定流不重跑）。
      const dispatched = result.next_action === "dispatched"
        ? `修复轮 Round ${result.dispatch?.round_index ?? "?"} 已按 task-fix 开跑（反馈即指令）`
        : "反馈已落账（fix-feedback-rN.md）"
      toast.success(`Phase ${awaitingPhase.index} Round ${awaitingPhase.awaitingRound} 已打回 — ${dispatched}`)
      // 决策响应自带新 task 快照 —— 独立挂载直接吸收；嵌入态交还给父级重拉
      // （detail 单源，本地不留第四份副本）。
      if (embedded) onRefetch?.()
      else setInternalDetail(result.task)
    } catch (err: unknown) {
      if (err instanceof TaskApiError && err.status === 409) {
        toast.error(`${err.message}（已刷新最新状态）`)
        refetchDetail()
      } else {
        toast.error(err instanceof Error ? err.message : "打回提交失败")
      }
    } finally {
      setBusy(null)
    }
  }, [task, awaitingPhase, feedback, gate.failTickets, busy, onMutated, refetchDetail, embedded, onRefetch])

  const requestAbort = useCallback(() => { if (!busy && !readOnly) setAbortOpen(true) }, [busy, readOnly])

  // 票 02 统一壳：把决策入口注册给宿主（右栏底部 通过/打回 按钮）。只是句柄注册
  // ——台账预览/反馈弹窗/硬闸拦截/409 恢复全部仍是本面这套函数，行为单源。
  // 票11 ⑩回补：requestAbort 一并注册（壳右栏「■ 中止」= 本面既有二次确认流，
  // railless 时内列按钮撤场，确认框/落库路径不变）。
  useEffect(() => {
    if (!onActionApi) return
    onActionApi({
      requestAccept,
      openReject,
      requestAbort,
      blocked: busy !== null || gate.fail > 0 || checksSaving,
    })
    return () => onActionApi(null)
  }, [onActionApi, requestAccept, openReject, requestAbort, busy, gate.fail, checksSaving])

  const handleAbort = useCallback(async () => {
    if (!task || busy) return
    setAbortOpen(false)
    setBusy("abort")
    try {
      await abortTask(task.id)
      toast.success("已中止任务，工作区将清理")
      onMutated()
      onDecided?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
      refetchDetail()
    } finally {
      setBusy(null)
    }
  }, [task, busy, onMutated, onDecided, refetchDetail])

  // autoAdvance 只读态（开关本体在 AuthoringWorkspace — 编辑仅 draft/ready 合法）。
  const autoOn = (detail?.task_spec ?? task?.task_spec)?.autoAdvance !== false

  const total = phaseViews.length

  const nextPhaseIndex = awaitingPhase
    ? phaseViews[phaseViews.findIndex((p) => p.index === awaitingPhase.index) + 1]?.index ?? "?"
    : null
  const roundOk = awaitingRound?.state === "succeeded"
  const roundFailed = awaitingRound?.state === "failed"
  const selfCheckLabel = verify?.state
    ? verifyStateLabel(verify.state)
    : isTakeoverArtifact ? "未跑（接管件）" : verifyStateLabel(undefined)
  const bannerTitle = readOnly
    ? "这轮已通过验收"
    : roundOk ? "这轮跑通了，等你确认" : roundFailed ? "这轮没跑成功，先看原因" : "这轮还在收尾"
  const bannerSub = [
    durationMs != null ? `用时 ${formatDuration(durationMs)}` : null,
    diffStats.commits > 0 ? `${diffStats.commits} 次提交` : null,
    `自动自检 ${selfCheckLabel}`,
  ].filter(Boolean).join(" · ")
  const bannerChip = readOnly
    ? { cls: "ok", text: "已验收 ✓" }
    : roundOk
      ? { cls: "ok", text: "可验收" }
      : roundFailed ? { cls: "bad", text: "需处理" } : { cls: "wait", text: "等待中" }

  // 验收方案是否就绪（2026-10-30）：ready → 用 A 方案面板（怎么验 / 证据 / 机器建议）。
  const planReady = playbook?.plan?.status === "ready"
  const planGuideActive = planReady && !!awaitingPhase && !readOnly

  return (
    <div
      className="acceptance-paper flex h-full min-h-0 flex-col"
      data-acceptance-modal
      data-acceptance-readonly={readOnly ? "1" : undefined}
      data-testid="acceptance-modal"
    >
      {/* ── 顶条：语境 + 阶段迷你轨道（不抢主线，只给方位） ── */}
      <div className="ap-subhead">
        <span className="ap-eyebrow">验收台</span>
        <span className="ap-context">
          {awaitingPhase ? (
            <>阶段 <b>{awaitingPhase.index}</b> / {total} · 第 {reviewRoundIndex ?? "—"} 轮{readOnly ? " · 已验收" : ""}</>
          ) : "当前没有待验收的轮次"}
        </span>
        {isTakeoverArtifact && (
          <span
            data-testid="acceptance-takeover-chip"
            className="ap-chip wait"
            title="本 Round 由人工接管交付：绑定流已停，自动复检未跑 —— 把关 = 人工核对 + 试一试（ADR-0025）"
          >
            ✋ 接管件 · 自动复检未跑
          </span>
        )}
        {sseDown && (
          <span
            className="ap-chip bad"
            data-sse-down data-testid="acceptance-sse-down"
            title="实时连接中断 —— 盘面停在断线时刻的快照，恢复后自动补拉"
          >
            ⚠ 连接中断 · 数据截至 {sseDownAt}
          </span>
        )}
        {readOnly ? (
          <span className="ap-chip ok" data-testid="acceptance-readonly-chip"><i />只读</span>
        ) : awaitingPhase && (
          <span className="ap-chip wait"><i />待验收</span>
        )}
        {phaseViews.length > 0 && (
          <div className="ap-mini" aria-label="阶段进度">
            {phaseViews.map((p, i) => {
              const done = p.acceptedRound !== null || p.status === "accepted"
              const current = awaitingPhase?.index === p.index
              // 归档只读：已验收 phase 可点回看（多 phase 时切换数据源）。
              const pickable = readOnly && p.acceptedRound != null
              const stepCls = `ap-mini-step ${done ? "done" : ""} ${current ? "current" : ""}`
              return (
                <span key={p.index} className="contents">
                  {i > 0 && <span className={`ap-mini-line ${done || current ? "done" : ""}`} />}
                  {pickable ? (
                    <button
                      type="button"
                      className={stepCls}
                      onClick={() => setReadOnlyPhasePick(p.index)}
                      aria-pressed={current}
                      title={`回看 Phase ${p.index} 的验收记录`}
                      data-testid={`acceptance-phase-${p.index}`}
                      style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
                    >
                      <i>{done ? "✓" : p.index}</i><span>{p.name}</span>
                    </button>
                  ) : (
                    <span className={stepCls}>
                      <i>{done ? "✓" : p.index}</i><span>{p.name}</span>
                    </span>
                  )}
                </span>
              )
            })}
          </div>
        )}
      </div>

      <div className="ap-layout">
        {/* ── 左导轨：三步 + 本轮快照 + 把关提示 ── */}
        {!railless && (
          <aside className="ap-rail" aria-label="验收步骤">
            <div className="ap-rail-title">跟着走，三步</div>
            {[
              { n: 1, t: "看结果", d: "改了什么，稳不稳" },
              { n: 2, t: "试一试", d: "自己跑一遍" },
              { n: 3, t: "拍个板", d: "通过，或说哪不对" },
            ].map((s) => (
              <button
                key={s.n}
                type="button"
                className={cn("ap-step", step === s.n && "active", step > s.n && "done")}
                onClick={() => setStep(s.n)}
                aria-current={step === s.n ? "step" : undefined}
                data-testid={`acceptance-step-${s.n}`}
              >
                <span className="ap-step-num">{step > s.n ? "✓" : s.n}</span>
                <span className="ap-step-text"><b>{s.t}</b><small>{s.d}</small></span>
              </button>
            ))}

            <div className="ap-snapshot" data-acceptance-col-summary data-testid="acceptance-col-summary">
              <div className="ap-snap-title">本轮快照</div>
              <div className="ap-snap-row">
                <span>阶段</span>
                <b data-acceptance-phase-label data-testid="acceptance-phase-label">
                  {awaitingPhase ? `Phase ${awaitingPhase.index}/${total} · Round ${reviewRoundIndex ?? "—"}` : "—"}
                </b>
              </div>
              <div className="ap-snap-row">
                <span>执行结果</span>
                <b
                  data-acceptance-round-state={awaitingRound?.state} data-testid="acceptance-round-state"
                  className={roundOk ? "good" : roundFailed ? "bad" : undefined}
                >
                  {awaitingRound ? ROUND_STATE_LABEL[awaitingRound.state] ?? awaitingRound.state : "—"}
                </b>
              </div>
              {roundError && (
                <div className="ap-snap-row" data-acceptance-round-error data-testid="acceptance-round-error">
                  <span>失败原因</span><b className="bad">{roundError}</b>
                </div>
              )}
              <div className="ap-snap-row">
                <span>用时</span>
                <b data-acceptance-duration data-testid="acceptance-duration">{durationMs != null ? formatDuration(durationMs) : "—"}</b>
              </div>
              <div className="ap-snap-row">
                <span>核对</span>
                <b data-testid="rail-walk-count">
                  {playbook?.available ? (
                    <>
                      <span className="good">{gate.pass}</span>/{gate.total}✓
                      {gate.fail > 0 && <span className="bad"> · ✗{gate.fail}</span>}
                      {gate.undecided > 0 && <span> · 未决 {gate.undecided}</span>}
                    </>
                  ) : "—"}
                </b>
              </div>
              <div className="ap-snap-row">
                <span>自动自检</span>
                <b className={verify?.state === "passed" ? "good" : verify?.state === "running" ? "warn" : verify?.state ? "bad" : isTakeoverArtifact ? "warn" : undefined}>
                  {selfCheckLabel}
                </b>
              </div>
              <div className="ap-snap-row">
                <span>预览</span>
                <b className={preview?.state === "ready" ? "good" : preview?.state === "starting" ? "warn" : undefined}>
                  {previewStateLabel(preview?.state)}
                </b>
              </div>
            </div>

            <div className="ap-tip">
              <b>你在把关什么？</b>
              确认这轮达到了阶段目标，也没有弄坏已有的东西。细节可以展开，但不必全看。
            </div>
          </aside>
        )}

        {/* ── 主内容：三步面板 + 常驻决策条 ── */}
        <div className="ap-main" data-acceptance-col-artifacts data-testid="acceptance-col-artifacts">
          <div className="ap-scroll">
            {/* 步骤 1 · 看结果 */}
            <section className={cn("ap-panel", step === 1 && "active")} data-step="1" aria-label="看结果">
              {!awaitingPhase ? (
                <div className="ap-empty" data-acceptance-batch-idle data-testid="acceptance-batch-idle">
                  当前无待验收 round — 验收时在这里看结果、跑一遍、做决定。
                </div>
              ) : (
                <>
                  <div className="ap-panel-eyebrow"><span className="line" />本轮结果</div>
                  <div className="ap-banner">
                    <span className={cn("ap-ring", roundOk ? undefined : roundFailed ? "bad" : "wait")}>
                      {roundOk ? "✓" : roundFailed ? "✕" : "…"}
                    </span>
                    <div>
                      <h3>{bannerTitle}</h3>
                      <p>{bannerSub}</p>
                    </div>
                    <span className={cn("ap-chip", bannerChip.cls)}><i />{bannerChip.text}</span>
                  </div>

                  <div className="ap-stats">
                    <div className="ap-stat"><div className="n">{diffStats.files}</div><div className="l">改动文件</div></div>
                    <div className="ap-stat"><div className="n add">+{diffStats.additions}</div><div className="l">新增行</div></div>
                    <div className="ap-stat"><div className="n del">−{diffStats.dels}</div><div className="l">删除行</div></div>
                    <div className="ap-stat"><div className="n">{durationMs != null ? formatDuration(durationMs) : "—"}</div><div className="l">执行用时</div></div>
                  </div>

                  {reportHighlights.length > 0 ? (
                    <>
                      <div className="ap-block">它做了什么<span className="aside">来自本轮报告</span></div>
                      <div className="ap-summary">
                        {reportHighlights.map((t, i) => (
                          <div key={i} className="ap-summary-item">
                            <span className="ap-summary-idx">{i + 1}</span><span>{t}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : playbook?.goal ? (
                    <>
                      <div className="ap-block">本阶段目标<span className="aside">来自阶段验收标准</span></div>
                      <div className="ap-summary">
                        <div className="ap-summary-item"><span className="ap-summary-idx">1</span><span>{playbook.goal}</span></div>
                      </div>
                    </>
                  ) : null}

                  <div className="ap-block">
                    改了什么
                    <span className="aside">按变更量排序</span>
                    {onOpenChanges && !readOnly && (
                      <button type="button" className="ap-block-link" onClick={onOpenChanges} data-testid="acceptance-open-changes">
                        全部变更 →
                      </button>
                    )}
                  </div>
                  {topFiles.length > 0 ? (
                    <div className="ap-changes">
                      {topFiles.map((f) => {
                        const totalChurn = f.adds + f.dels
                        const addPct = totalChurn === 0 ? 100 : Math.round((f.adds / totalChurn) * 100)
                        return (
                          <div key={`${f.repo}/${f.path}`} className="ap-change">
                            <span className="ap-fname" title={`${f.repo}/${f.path}`}>
                              {f.path}<span className="ap-frepo">{f.repo}</span>
                            </span>
                            <span className="ap-bar"><i className="a" style={{ width: `${addPct}%` }} /><i className="d" style={{ width: `${100 - addPct}%` }} /></span>
                            <span className="ap-counts"><span className="a">+{f.adds}</span> <span className="d">−{f.dels}</span></span>
                          </div>
                        )
                      })}
                      {restFiles.length > 0 && (
                        readOnly ? (
                          <span className="ap-more" data-testid="acceptance-more-files-readonly">
                            还有 {restFiles.length} 个文件 · +{restAdds} / −{restDels}
                          </span>
                        ) : (
                          <button type="button" className="ap-more" onClick={onOpenChanges} disabled={!onOpenChanges}>
                            还有 {restFiles.length} 个文件 · +{restAdds} / −{restDels}
                          </button>
                        )
                      )}
                    </div>
                  ) : (
                    <div className="ap-empty">
                      {roundDiff && !roundDiff.available
                        ? "本轮没有可展示的文件级变更（diff 不可得或工作区已清理）。"
                        : "本轮没有文件级变更。"}
                    </div>
                  )}

                  <div className="ap-block">核对证据<span className="aside">规格 × 报告 × 实物，自动对账</span></div>
                  <AcMatrixPanel
                    specMd={specMd === "" ? null : specMd}
                    specLoading={specLoading}
                    reportMd={roundReport}
                    diff={roundDiff}
                    fixReportMd={fixReportMd}
                    hasFixFeedback={!!fixFeedbackFile}
                  />

                  <div className="ap-foot">
                    <span className="ap-foot-note">看不懂代码也没关系 —— 下一步直接跑一遍。</span>
                    <span className="ap-spacer" />
                    <button type="button" className="ap-btn ap-btn-primary" onClick={() => setStep(2)} data-testid="acceptance-next-2">
                      下一步：试一试 <ArrowRight className="size-3.5" />
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* 步骤 2 · 试一试 */}
            <section className={cn("ap-panel", step === 2 && "active")} data-step="2" aria-label="试一试">
              <div className="ap-panel-eyebrow"><span className="line" />自己跑一遍</div>
              <h2 className="ap-heading">试试看，不用只信文字</h2>
              <p className="ap-sub">预览连的是本轮的工作区。起服务、点一遍，再跑一次自动自检。</p>

              {awaitingPhase ? (
                <>
                  <div className="mt-3 space-y-3">
                    <PreviewBar
                      cfg={previewCfg}
                      runbook={runbookCfg}
                      preview={preview}
                      busy={previewBusy}
                      disabledReason={readOnlyReason ?? (wsGone ? "工作区目录已不在 — 预览不可用" : undefined)}
                      onSaveCfg={handlePreviewSave}
                      onSaveRunbook={handleRunbookSave}
                      onStart={() => void handlePreviewStart()}
                      onStop={() => void handlePreviewStop()}
                    />
                    <VerifyPanel
                      cfg={verifyCfg}
                      summary={verify}
                      lines={verifyLines}
                      running={!!verifyRunning}
                      busy={verifyBusy}
                      disabledReason={verifyDisabled}
                      onSaveCommand={handleVerifySave}
                      onOpenVerdict={(p) => setHomeViewing({ path: p })}
                      onRun={() => void handleVerifyRun()}
                      onAbort={() => void handleVerifyAbort()}
                    />
                    <InstancesPanel
                      taskId={taskId ?? ""}
                      rev={(preview?.state ?? "stopped") + (reviewRoundIndex ?? 0)}
                      disabledReason={readOnlyReason ?? (wsGone ? "工作区目录已不在 — 回收不可用" : undefined)}
                    />
                  </div>
                  <div className="ap-foot">
                    <button type="button" className="ap-btn ap-btn-ghost" onClick={() => setStep(1)}>
                      <ChevronLeft className="size-3.5" /> 上一步
                    </button>
                    <span className="ap-foot-note">没跑起来？先看日志再决定，不必硬凑。</span>
                    <span className="ap-spacer" />
                    <button type="button" className="ap-btn ap-btn-primary" onClick={() => setStep(3)} data-testid="acceptance-next-3">
                      都看过了，去拍板 <ArrowRight className="size-3.5" />
                    </button>
                  </div>
                </>
              ) : (
                <div className="ap-empty mt-3">当前没有待验收的轮次，暂时不用试。</div>
              )}
            </section>

            {/* 步骤 3 · 拍个板 */}
            <section className={cn("ap-panel", step === 3 && "active")} data-step="3" aria-label="拍个板">
              <div className="ap-panel-eyebrow"><span className="line" />最后，拍个板</div>
              <h2 className="ap-heading">逐项过一遍，然后做决定</h2>
              <p className="ap-sub">
                {planReady
                  ? "验收方案由独立的规划 Agent 按本轮证据生成 —— 每项都写明怎么验、证据在哪、机器建议。主对话里的 Agent 也可以一步步带你走。"
                  : "清单是根据本阶段的验收标准自动生成的。点一下可以在「通过 / 未通过 / 跳过」之间切换。"}
              </p>

              <div className="ap-check-note">
                <span className="q">i</span>
                <span>
                  机器只给建议，<b>最终由你逐项确认</b>。出现任何一项 <b>✕ 未通过</b>，通过按钮会被拦下 —— 这是有意的。
                  跳过项会写进记录，带到下一轮补验。
                </span>
              </div>

              <div className="mt-3 space-y-3">
                {playbook && !planReady && (
                  <div
                    className={cn("ap-check-note", playbook.plan?.status === "failed" && "warn")}
                    data-testid="plan-status-note"
                    data-plan-status={playbook.plan?.status ?? "missing"}
                  >
                    <span className="q">{playbook.plan?.status === "failed" ? "!" : "i"}</span>
                    <span>
                      {playbook.plan?.status === "generating"
                        ? "验收方案正在生成（规划 Agent 在读本轮证据）—— 完成后本清单会自动切换为「怎么验 / 证据 / 机器建议」。"
                        : playbook.plan?.status === "failed"
                          ? `验收方案生成失败${playbook.plan.error ? `（${playbook.plan.error}）` : ""} —— 已回退旧清单，验收不受影响。`
                          : "本轮没有预生成验收方案 —— 下面是按契约文件编译的清单。"}
                      {playbook.plan?.status === "failed" && (
                        <button
                          type="button"
                          className="ap-block-link"
                          data-testid="plan-regenerate"
                          onClick={() => {
                            void regenerateAcceptancePlan(taskId ?? "")
                              .then((r) => {
                                if (!r.ok) { toast.error(`重生成被拒：${r.reason ?? "未知原因"}`); return }
                                toast.success("已重新发起方案生成")
                                setPlaybookNonce((v) => v + 1)
                              })
                              .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "重生成失败"))
                          }}
                        >
                          ↻ 重新生成
                        </button>
                      )}
                    </span>
                  </div>
                )}
                {playbook ? (
                  planReady ? (
                    <AcceptancePlanPanel
                      taskId={taskId ?? ""}
                      batchRelDir={batchDir}
                      roundIndex={reviewRoundIndex ?? 0}
                      playbook={playbook}
                      guideActive={planGuideActive}
                      onGate={setGate}
                      disabledReason={readOnlyReason ?? (wsGone ? "工作区已清理 — 勾选暂停（历史记录与机器裁决仍在）" : undefined)}
                      onPlanEvent={() => setPlaybookNonce((v) => v + 1)}
                      registerFlush={registerPlaybookFlush}
                      onSaveStateChange={setChecksSaving}
                      onOpenFile={(p) => setHomeViewing({ path: p })}
                    />
                  ) : (
                    <PlaybookPanel
                      taskId={taskId ?? ""}
                      batchRelDir={batchDir}
                      roundIndex={reviewRoundIndex ?? 0}
                      playbook={playbook}
                      onGate={setGate}
                      disabledReason={readOnlyReason ?? (wsGone ? "工作区已清理 — 勾选暂停（历史记录与机器裁决仍在）" : undefined)}
                      saving={checksSaving}
                      onSaveStateChange={setChecksSaving}
                      registerFlush={registerPlaybookFlush}
                    />
                  )
                ) : (
                  <div className="ap-empty">正在读取核对清单…</div>
                )}
              </div>

              {hasNextPhase && !rejectOpen && awaitingPhase && !readOnly && (
                <p className="ap-handoff mt-2" data-handoff-hint data-testid="handoff-hint">
                  {`本 phase 的 handoff.md 连同已 accepted 共 ${handoffCount} 个前序交接，将自动进入下一 phase 执行会话`}
                </p>
              )}
              {readOnly ? (
                <p className="ap-meta-line mt-1" data-testid="acceptance-readonly-note">
                  已通过验收 · 只读 — 决策与勾选已冻结。机器台账
                  {" "}<code>acceptance-ledger-r{reviewRoundIndex ?? "?"}.md</code>{" "}
                  在批次目录（作业坞「产物」可查）。
                </p>
              ) : (
                <div className={cn("ap-meta-line mt-1", !autoOn && "warn")} data-autoadvance-readonly data-testid="autoadvance-readonly">
                  验收通过后自动开跑下一 Phase：<b>{autoOn ? "开" : "关（停在你的 gate）"}</b>
                </div>
              )}

              {rejectedSeam && (
                <div className="ap-reject-echo" data-agent-recommend-card data-testid="agent-recommend-card">
                  <b><Bot className="mr-1 inline size-3" />已退回 Round {rejectedSeam.roundIndex} — 已派 task-fix 修复轮</b>
                  <p>
                    反馈 {rejectedSeam.feedback.length} 字已落 fix-feedback-r{rejectedSeam.roundIndex}.md，
                    即 task-fix 修复指令（解析→开发/修复→回归→补产物→自动回待验收）。
                    覆盖仅作用本轮 — phase 绑定不变（K16）。
                  </p>
                </div>
              )}
            </section>
          </div>

          {/* ── 常驻决策条：只在第三步出现，不遮挡清单；归档只读时整条不渲染 ── */}
          {!railless && !readOnly && (
            <div
              className={cn("ap-decision", step === 3 && "show")}
              data-acceptance-col-actions data-testid="acceptance-col-actions"
            >
              {awaitingPhase ? (
                <>
                  <span className="ap-decision-text">
                    <b>{gate.pass}</b> 项通过
                    {gate.skip > 0 && <> · <span className="skip">{gate.skip} 项跳过</span></>}
                    {gate.fail > 0 && <> · <span className="bad">{gate.fail} 项未通过</span></>}
                    {" "}/ 共 {gate.total} 项
                  </span>
                  <span className={cn("ap-guard", gate.fail > 0 && "show")} data-testid="acceptance-approve-blocked">
                    ✕ 未过 {gate.fail} 项 —— 通过被拦，请退回修改（反馈已预填）
                  </span>
                  <span className="ap-decision-actions">
                    <button
                      type="button" className="ap-btn ap-btn-ghost" disabled={busy !== null}
                      onClick={requestAbort}
                      data-acceptance-abort data-testid="acceptance-abort"
                    >
                      {busy === "abort" ? <Spinner className="size-3.5" /> : <Ban className="size-3.5" />} 中止
                    </button>
                    <button
                      type="button" className="ap-btn ap-btn-ghost" disabled={busy !== null}
                      onClick={() => openReject()}
                      data-acceptance-reject data-testid="acceptance-reject"
                    >
                      <Undo2 className="size-3.5" /> 退回修改
                    </button>
                    <button
                      type="button"
                      className="ap-btn ap-btn-primary"
                      disabled={busy !== null || gate.fail > 0 || checksSaving}
                      title={checksSaving ? "核对勾选保存中 — 稍候再提交（防止记录少记最后一笔）" : undefined}
                      onClick={requestAccept}
                      data-acceptance-approve data-testid="acceptance-approve"
                    >
                      {busy === "accept" ? <Spinner className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                      {awaitingPhase.index === total ? "通过，进入归档" : `通过，进入阶段 ${nextPhaseIndex}`}
                    </button>
                  </span>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground" data-acceptance-idle>
                  {rejectedSeam ? "已退回 — 修复轮在跑（上方为去向回显）。" : "当前无待验收 round — 状态由 SSE 实时刷新。"}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 退回反馈弹窗：反馈即修复指令（ADR-0024 单路径）。 */}
      <Dialog
        open={rejectOpen}
        onOpenChange={(o) => { if (!o && busy !== "reject") setRejectOpen(false) }}
      >
        <DialogContent className="acceptance-sheet sm:max-w-[540px]" data-reject-dialog data-testid="reject-dialog">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {`退回 阶段 ${awaitingPhase?.index ?? "?"} · 第 ${awaitingPhase?.awaitingRound ?? "?"} 轮 — 说清哪里不对`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3" data-reject-panel>
            <label className="text-[11px] font-medium text-pop-ink">
              反馈（必填 — 落 fix-feedback-r{awaitingPhase?.awaitingRound}.md，即修复轮的指令）
            </label>
            <Textarea
              rows={6}
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="哪里不对 / 期望怎么修 — agent 修复轮以此为输入"
              className="min-h-[120px] text-xs"
              data-reject-feedback data-testid="reject-feedback"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setRejectOpen(false)}>
                取消
              </Button>
              <Button
                size="sm"
                className="h-auto py-1.5 text-xs whitespace-normal text-right leading-snug"
                disabled={!feedback.trim() || busy !== null}
                onClick={() => void handleReject()}
                data-reject-confirm data-testid="reject-confirm"
              >
                {busy === "reject" ? <Spinner className="size-3 mr-1" /> : null}
                确认退回 · 开始修复 R{awaitingPhase?.awaitingRound != null ? awaitingPhase.awaitingRound + 1 : "?"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 通过 · 验收记录预览（确认即机写，不可改） */}
      <Dialog open={ledgerOpen} onOpenChange={(o) => { if (!o && busy !== "accept") setLedgerOpen(false) }}>
        <DialogContent className="acceptance-sheet sm:max-w-[560px]" data-testid="ledger-dialog">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {gate.undecided > 0
                ? `有 ${gate.undecided} 项核对未决 —— 确认跳过并放行？`
                : `全 ${gate.pass} 项核对通过 —— 确认验收通过？`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-[11.5px]">
            {playbook?.goal && <p className="font-semibold text-pop-ink">{playbook.goal}</p>}
            <div className="rounded-md border border-pop-bd bg-pop-idle/30 p-2 font-mono text-[10.5px] leading-relaxed">
              <div>实物 · {roundDiff?.available ? `${diffStats.commits} commits · +${diffStats.additions}/−${diffStats.dels} · ${diffStats.files} 文件` : "无有效 diff"}</div>
              <div data-testid="ledger-preview-intervention">人工干预 · ×{roundDiff?.manualInterventions?.length ?? 0}（agent_events · harness 干预另计 {diffStats.interventions ?? "—"}）</div>
              <div data-testid="ledger-preview-quick-edit">快速修改 · ×{roundDiff?.quickEdits?.length ?? 0}（[quick-edit] 提交）{roundDiff?.quickEdits?.length ? ` · ${new Set(roundDiff.quickEdits.flatMap((e) => e.files)).size} 文件` : ""}</div>
              <div data-testid="ledger-preview-takeover">接管标记 · {isTakeoverArtifact ? (verify?.state ? "人工交付（接管件）· 复检真结果为准" : "人工交付 · 自动复检未跑（接管件）") : "无（绑定流机器轮）"}</div>
              <div>自动自检 · {verify?.state ? `${verify.state}${verify.exit_code != null ? ` (exit ${verify.exit_code})` : ""}` : isTakeoverArtifact ? "未跑（接管件）" : "未跑（≠失败）"}</div>
              <div>试一试 · {preview && preview.state !== "stopped" ? `${previewStateLabel(preview.state)}${preview.url ? ` @ ${preview.url}` : ""}（决策时自动停止）` : "未使用"}</div>
              <div>人工核对 · ✓{gate.pass} · ✗{gate.fail} · ⊘{gate.skip} · 未决{gate.undecided} / 计{gate.total}</div>
            </div>
            {gate.skip > 0 && <p className="text-[10.5px] text-pop-amber">⊘ 跳过项将进入下一轮 carryover 首段（补验或再豁免），并写入验收记录。</p>}
            {gate.undecided > 0 && <p className="text-[10.5px] text-muted-foreground">未决项会以「未勾选」记入验收记录 —— 永久留痕。</p>}
            <p className="text-[10px] text-muted-foreground">确认后 server 机写 acceptance-ledger-r{awaitingPhase?.awaitingRound}.md 进批次目录（审计留痕，不可改）。</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLedgerOpen(false)}>再看看</Button>
            <Button size="sm" className="h-auto py-1.5 text-xs whitespace-normal leading-snug" disabled={busy !== null} onClick={() => void doAccept()} data-testid="ledger-confirm">
              {busy === "accept" ? <Spinner className="size-3 mr-1" /> : null}确认通过 · 写验收记录
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 中止 · 危险二次确认（D8） */}
      <ConfirmDialog
        open={abortOpen}
        onOpenChange={(o) => { if (!o && busy !== "abort") setAbortOpen(false) }}
        title={`中止任务「${task?.name ?? ""}」？`}
        description="在跑的复检 / 预览会被一并 SIGTERM；Phase 置 aborted 不可恢复 —— 票与 diff 保留，可整任务重开。"
        confirmLabel="确认中止"
        variant="destructive"
        loading={busy === "abort"}
        onConfirm={() => void handleAbort()}
      />

      <ArtifactViewerDialog
        taskId={taskId ?? ""}
        entry={null}
        homeEntry={homeViewing}
        onOpenChange={(o) => { if (!o) setHomeViewing(null) }}
      />
    </div>
  )
}

/** round-report 的「主要改动 / 变更摘要」子弹列表 → 步骤 1 的摘要行。
 *  只读报告原文，不调 AI、不臆造。 */
function extractReportHighlights(md: string | null): string[] {
  if (!md) return []
  const heading = /^##\s*(?:主要改动|改动摘要|变更摘要|Changes?)\s*$/im.exec(md)
  if (!heading) return []
  const section = md.slice(heading.index + heading[0].length).split(/^##\s/m)[0] ?? ""
  return section
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 4)
}
