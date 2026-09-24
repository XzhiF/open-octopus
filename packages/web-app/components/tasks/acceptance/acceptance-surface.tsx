// packages/web-app/components/tasks/acceptance/acceptance-surface.tsx
//
// 验货台 —— 执行控制台的「验货台」tab（2026-09-16 改版：从独立三栏弹窗
// AcceptanceModal 收编为 tab，父窗（TaskModal 执行控制台）自带拖拽/缩放/
// 全屏，弹窗层数 3→2，原弹窗宽度截断与多层 modal 交互死锁一并消除）。
//
//   ┌ 主面（左，吃满剩余宽）：实物 | 核对 两 sub-tab（叙述 tab 已于 2026-09-20
//   │     用户裁决删除：round-report 已被核对三方对账消费，批次目录直读无验收增量；
//   │     verdict 文件入口收进复检块，点开走 ArtifactViewerDialog）
//   │     实物 = 待验收轮 start..end 的真实 git diff（RoundEvidenceService 服务端
//   │     解析,web 不见 SHA）+ 当场复检（acceptance_verify 命令在活工作区现跑,
//   │     task_verify/_log SSE 流式,PASS/FAIL 盖章,verdict .md 落批次目录,
//   │     结束后台保留可见、可折叠）;
//   │     核对 = spec 票 × 报告声称 × diff 实物路径三方对账（lib/acceptance-matrix,
//   │     纯解析零 AI; round-report.md 拉取定位仍走批次目录 listHomeDir）
//   └ 右侧栏（360px，摘要上/动作下各自滚动）：执行摘要（round 用时/失败原因/
//         token/cost — AggInline 紧凑口径）+ 动作区（验收通过/打回[反馈必填]/
//         中止 + autoAdvance 只读态）
//
// 数据权威 = GET /:id 的 derived（票 03/07 唯一真相；票 11 已镜像类型）——
// 本组件只读 phaseViews，MUST NOT 重实现派生矩阵。提交走票 11 交付的
// postAcceptance（409=他处已决/态变 → 重拉 derived 刷新盘面；400=表单缺陷）。
// 决策生效（通过/中止）后 onDecided → 控制台切回「执行控制台」tab；打回
// 不切（回显卡 + 影响清单留在原地）。
//
// 兼容注记：根锚点沿用 data-acceptance-modal / testid acceptance-modal（e2e
// task-phase-acceptance / lifecycle 的 `[data-acceptance-modal]` 选择器直接
// 命中内嵌面），三列锚点 data-acceptance-col-* 原样。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Ban, Bot, CheckCircle2, FileText, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, AcceptanceVerify, AcceptancePreview, AcceptanceRunbook } from "@octopus/shared"
import {
  PHASE_STATUS_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, TASK_STATUS_EVENT,
  TASK_VERIFY_EVENT, TASK_VERIFY_LOG_EVENT, TASK_PREVIEW_EVENT,
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
  type HomeFileListingEntry,
  type RoundDiffPayload,
  type RoundDiffScope,
  type VerifySummary,
  type VerifyState,
  type PlaybookPayload,
  type PreviewSummary,
  type TaskDetail,
  type TaskPhaseView,
  type TaskRoundView,
} from "@/lib/tasks-api"
import { formatDuration } from "@/lib/format"
import { subscribeSSE, subscribeSSEStatus } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { ArtifactViewerDialog, type HomeViewEntry } from "../authoring/artifact-viewer-dialog"
import { batchDirOf } from "../authoring/phase-spec-dialog"
import { isRelativeScratchSpec } from "../authoring/use-batch-tree"
import { RoundDiffPanel } from "./round-diff-panel"
import { VerifyPanel } from "./verify-panel"
import { PreviewBar } from "./preview-bar"
import { InstancesPanel } from "./instances-panel"
import { PlaybookPanel } from "./playbook-panel"
import { AcMatrixPanel } from "./ac-matrix-panel"
import { runErrorOf } from "../execution-summary"
import { verifyStateLabel, previewStateLabel } from "./acceptance-labels"
import { ConfirmDialog } from "@/components/scheduler/confirm-dialog"

// ── Props ────────────────────────────────────────────────────────────

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
}

const ROUND_STATE_LABEL: Record<string, string> = {
  pending: "排队中", running: "执行中", succeeded: "执行成功",
  failed: "执行失败", cancelled: "已取消/中止",
}

export function AcceptanceSurface({ task, onMutated, onDecided, detailOverride, onRefetch }: AcceptanceSurfaceProps) {
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

  // 打回子块（右列展开）+ 提交后的路由回显/D14 接缝卡。
  const [rejectOpen, setRejectOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  // ADR-0018 打回二分路由：rerun=修订重跑（缺省，重跑绑定流）；fix=轻量修复(task-fix)。
  const [nextFlow, setNextFlow] = useState<"rerun" | "fix">("rerun")
  const [busy, setBusy] = useState<"accept" | "reject" | "abort" | null>(null)
  const [rejectedSeam, setRejectedSeam] = useState<{ phaseIndex: number; roundIndex: number; feedback: string; flow: "rerun" | "fix" } | null>(null)
  // specPath 绝对/缺失（gateV4 容忍 agent 旁路直写）时的批次定位回退位：
  // getBatchTree 按 slug 取 latest_mtime 最新 dir（specPath 优先,正常 v4 恒命中）。
  const [fallbackDir, setFallbackDir] = useState<string | null>(null)
  // ── 验货台 (acceptance v2) 状态 ──
  // subTab：实物(默认=C位) | 核对；roundDiff=真实提交区间；verify=当场复检。
  const [midTab, setMidTab] = useState<"diff" | "matrix">("diff")
  const [roundDiff, setRoundDiff] = useState<RoundDiffPayload | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffReload, setDiffReload] = useState(0) // 实物面板「重试」
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
    setRejectOpen(false)
    setFeedback("")
    setNextFlow("rerun")
    setRejectedSeam(null)
    setFiles(null)
    setRoundReport(null)
    setFallbackDir(null)
    setMidTab("diff")
    setRoundDiff(null)
    setDiffError(null)
    setDiffScope("round")
    setCumDiff(null)
    setCumError(null)
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
    return () => { unPhase(); unStatus(); unArts(); unVLog(); unVerify(); unPreview() }
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
  const phaseViews = detail?.derived?.phaseViews ?? []
  const awaitingPhase: TaskPhaseView | null = useMemo(
    () => phaseViews.find((p) => p.status === "awaiting_review" && p.awaitingRound !== null) ?? null,
    [phaseViews],
  )
  const awaitingRound: TaskRoundView | null = useMemo(() => {
    if (!awaitingPhase || awaitingPhase.awaitingRound == null) return null
    return awaitingPhase.rounds.find((r) => r.roundIndex === awaitingPhase.awaitingRound) ?? null
  }, [awaitingPhase])

  // ── 验收面 v2.1：剧本编译 + 预览会话恢复 ──
  // playbook：按 awaiting 轮现拉（服务端派生；409 无 awaiting → null 静默，面板有 idle 态）。
  // preview：挂载 GET 一次（SSE 无 replay；external 探活由 server 兜）。execId 换轮即重拉。
  useEffect(() => {
    if (!taskId || !awaitingRound) { setPlaybook(null); return }
    let cancelled = false
    getPlaybook(taskId)
      .then((p) => { if (!cancelled) setPlaybook(p) })
      .catch(() => { if (!cancelled) setPlaybook(null) })
    return () => { cancelled = true }
  }, [taskId, awaitingRound?.exec.id])

  useEffect(() => {
    if (!taskId || !awaitingRound) return
    let cancelled = false
    getPreview(taskId)
      .then((s) => { if (!cancelled && s) setPreview(s) })
      .catch(() => { /* not wired / offline */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, awaitingRound?.exec.id])

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
    if (!taskId || !awaitingExecId) { setRoundDiff(null); setDiffError(null); return }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    getRoundDiff(taskId)
      .then((d) => { if (!cancelled) setRoundDiff(d) })
      .catch((err: unknown) => {
        if (cancelled) return
        setRoundDiff(null)
        setDiffError(err instanceof Error ? err.message : "实物 diff 读取失败")
      })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [taskId, awaitingExecId, diffReload])

  // ── 实物口径（B 档 / server S3）：本轮 = 本次执行增量；累计 = 本 phase 全轮 ──
  // 修复轮旧病：人只看到 delta，放行对象却是整个 phase 终态。cumulative 按需拉、
  // 换轮/重试即清仓；round-1 时两口径同物，开关不出现。
  const [diffScope, setDiffScope] = useState<RoundDiffScope>("round")
  const [cumDiff, setCumDiff] = useState<RoundDiffPayload | null>(null)
  const [cumLoading, setCumLoading] = useState(false)
  const [cumError, setCumError] = useState<string | null>(null)
  useEffect(() => {
    if (!taskId || !awaitingExecId || diffScope !== "cumulative") return
    let cancelled = false
    setCumLoading(true)
    setCumError(null)
    getRoundDiff(taskId, "cumulative")
      .then((d) => { if (!cancelled) setCumDiff(d) })
      .catch((err: unknown) => {
        if (cancelled) return
        setCumDiff(null)
        setCumError(err instanceof Error ? err.message : "累计 diff 读取失败")
      })
      .finally(() => { if (!cancelled) setCumLoading(false) })
    return () => { cancelled = true }
  }, [taskId, awaitingExecId, diffScope, diffReload])

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
        setVerify(s)
        if (s.tail?.length) setVerifyLines(s.tail)
      })
      .catch(() => { /* 未装配/离线 — 无会话可恢复 */ })
    return () => { cancelled = true }
  }, [taskId, awaitingExecId])

  // 核对 tab 的 spec.md：首访懒拉，"" 缓存「不存在」防重拉风暴。once 门走 ref
  // （不进 deps → 不会被 setSpecLoading 自己的重跑掐死,见声明处注释）。
  useEffect(() => {
    if (!taskId || !batchDir || midTab !== "matrix") return
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
  }, [taskId, batchDir, midTab])

  const verifyCfg = (detail?.task_spec ?? task?.task_spec)?.acceptance_verify ?? null
  const verifyRunning = verify?.state === "running"
  const wsGone = roundDiff !== null && !roundDiff.available && roundDiff.reason === "no_workspace"
  const verifyDisabled = wsGone
    ? "工作区目录已不在 — 当场复检不可用（历史输出/verdict 仍可看）"
    : undefined

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
    if (busy) return
    if (gate.fail > 0) { toast.error("存在 ✗ 未过项 —— 通过被拦，请改走打回（反馈已预填）"); return }
    setLedgerOpen(true)
  }, [busy, gate.fail])

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
  const openReject = useCallback(() => {
    if (busy) return
    if (!feedback.trim() && gate.failTickets.length) {
      setFeedback(`未过（验收台剧本 ✗）：\n${gate.failTickets.map((t) => `- ${t}`).join("\n")}\n\n补充：\n`)
    }
    setRejectOpen(true)
  }, [busy, feedback, gate.failTickets])

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
        next_flow: nextFlow, // ADR-0018 二分路由（round 级，只作用下一轮）
        ...(gate.failTickets.length ? { reopen_tickets: gate.failTickets } : {}), // ADR-0022 ✗→票重开
      })
      setRejectedSeam({
        phaseIndex: awaitingPhase.index,
        roundIndex: awaitingPhase.awaitingRound,
        feedback: trimmed,
        flow: nextFlow,
      })
      setRejectOpen(false)
      setFeedback("")
      onMutated()
      // server 已写 fix-feedback-rN.md + 按所选路由即时开轮（票 07 AC3 / ADR-0018）。
      const dispatched = result.next_action === "dispatched"
        ? nextFlow === "fix"
          ? `轻量修复 Round ${result.dispatch?.round_index ?? "?"} 已按 task-fix 开跑`
          : `修订重跑 Round ${result.dispatch?.round_index ?? "?"} 已按绑定流开跑（流内先再审 spec）`
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
  }, [task, awaitingPhase, feedback, nextFlow, gate.failTickets, busy, onMutated, refetchDetail, embedded, onRefetch])

  const requestAbort = useCallback(() => { if (!busy) setAbortOpen(true) }, [busy])

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

  return (
    <div className="flex h-full min-h-0 flex-col" data-acceptance-modal data-testid="acceptance-modal">
      {/* 顶条（原弹窗 DialogHeader 的下沉替身）：语境 + 一句宪法。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-pop-bd/15 bg-pop-paper px-4 py-1.5">
        <span className="text-[13px] font-black">验收 · 验货台</span>
        {awaitingPhase && (
          <span className="text-xs text-muted-foreground tabular-nums" data-acceptance-phase-label data-testid="acceptance-phase-label">
            {`Phase ${awaitingPhase.index}/${total} · Round ${awaitingPhase.awaitingRound}`}
          </span>
        )}
        {task && <Badge variant="outline" className="max-w-[260px] truncate text-[10px]">{task.name}</Badge>}
        {sseDown && (
          <span
            className="rounded-full border-2 border-pop-red bg-[#ffe3e9] px-2 py-px font-mono text-[9.5px] font-black text-pop-red"
            data-sse-down data-testid="acceptance-sse-down"
            title="实时连接中断 —— 盘面停在断线时刻的快照，恢复后自动补拉"
          >
            ⚠ 连接中断 · 数据截至 {sseDownAt}
          </span>
        )}
        <span className="ml-auto hidden text-[10px] text-muted-foreground sm:block">
          实物 · 核对 | 右侧摘要 + 动作 — 验收 = 验货，不是读汇报
        </span>
      </div>

      {/* 右栏单滚动容器（v2.5，用户：「动作区还有个上下的滚动条。单独的。很恶心」）：
          摘要 + 动作合进同一个滚动壳 —— 内容装得下就零滚动条；DOM 序 右栏→主面，
          flex+order 还原视觉（主面左、右栏 360px）。max-lg 纵排 col-reverse（主面上）。 */}
      <div className="flex min-h-0 flex-1 max-lg:flex-col-reverse max-lg:overflow-y-auto">
        {/* ── 右栏（A′，v2.1）：验收进度 + 决策（唯一入口）。token/cost 已迁出 ── */}
        <div className="order-2 flex w-[240px] shrink-0 flex-col overflow-y-auto border-l border-border max-lg:order-none max-lg:w-full max-lg:overflow-visible max-lg:border-l-0 max-lg:border-b">
        <div className="space-y-2 p-3 pb-2" data-acceptance-col-summary data-testid="acceptance-col-summary">
          <div className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">验收进度</div>
          {!detail ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> 读取派生视图…</div>
          ) : !awaitingRound ? (
            <p className="text-[11px] text-muted-foreground" data-acceptance-no-round>
              {rejectedSeam ? `本 Phase 已打回（Round ${rejectedSeam.roundIndex}）— 修复轮在跑。` : "当前无待验收 round。"}
            </p>
          ) : (
            <div className="space-y-1 text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-muted-foreground">Phase</span>
                <span className="min-w-0 truncate text-right font-medium" title={`${awaitingPhase?.index}/${total} ${awaitingPhase?.name}`}>{awaitingPhase?.index}/{total}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">执行结果</span>
                <span
                  data-acceptance-round-state={awaitingRound.state} data-testid="acceptance-round-state"
                  className={awaitingRound.state === "succeeded" ? "text-pop-green" : awaitingRound.state === "failed" ? "text-pop-amber" : "text-muted-foreground"}
                >
                  {ROUND_STATE_LABEL[awaitingRound.state] ?? awaitingRound.state}
                </span>
              </div>
              {roundError && (
                <div className="text-pop-amber break-words text-[10.5px]" data-acceptance-round-error data-testid="acceptance-round-error">{roundError}</div>
              )}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">用时</span>
                <span className="tabular-nums" data-acceptance-duration data-testid="acceptance-duration">{durationMs != null ? formatDuration(durationMs) : "—"}</span>
              </div>
              <hr className="border-border" />
              {playbook?.available ? (
                <>
                  <div className="flex items-baseline justify-between gap-2" data-testid="rail-walk-count">
                    <span className="text-muted-foreground">走查</span>
                    <b className="tabular-nums">
                      <span className="text-pop-green">{gate.pass}</span>/<span className="text-pop-dim">{gate.total}</span>✓
                      {gate.fail > 0 && <span className="text-pop-red"> · ✗{gate.fail}</span>}
                      {gate.undecided > 0 && <span className="text-muted-foreground"> · 未决{gate.undecided}</span>}
                    </b>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">跳过</span>
                    <span className="tabular-nums text-pop-amber">⊘{gate.skip} → 下轮</span>
                  </div>
                </>
              ) : (
                <div className="text-[10px] text-muted-foreground">本轮无编译剧本（见实物/核对佐证）</div>
              )}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">自动复检</span>
                <span className={verify?.state === "passed" ? "text-pop-green" : verify?.state === "running" ? "text-pop-amber" : verify?.state ? "text-pop-red" : "text-muted-foreground"}>
                  {verifyStateLabel(verify?.state)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">预览</span>
                <span className={preview?.state === "ready" ? "text-pop-green" : preview?.state === "starting" ? "text-pop-amber" : "text-muted-foreground"}>{previewStateLabel(preview?.state)}</span>
              </div>
            </div>
          )}
        </div>

        {/* ── 右侧栏下：动作区 ── */}
        <div className="border-t border-border p-4 pt-3 space-y-3" data-acceptance-col-actions data-testid="acceptance-col-actions">
          <div className="text-xs font-semibold text-muted-foreground">动作区</div>

          {awaitingPhase ? (
            <>
              {hasNextPhase && !rejectOpen && (
                <p className="text-[10px] text-muted-foreground" data-handoff-hint data-testid="handoff-hint">
                  {`本 phase 的 handoff.md 连同已 accepted 共 ${handoffCount} 个前序交接，将自动进入下一 phase 执行会话`}
                </p>
              )}
              <Button
                className="h-auto w-full py-1.5 whitespace-normal text-center leading-snug"
                size="sm"
                disabled={busy !== null || gate.fail > 0 || checksSaving}
                title={checksSaving ? "走查勾选保存中 — 稍候再提交（防止台账少记最后一笔）" : undefined}
                onClick={requestAccept}
                data-acceptance-approve data-testid="acceptance-approve"
              >
                {busy === "accept" ? <Spinner className="size-4 mr-1" /> : <CheckCircle2 className="size-4 mr-1" />}
                验收通过{awaitingPhase.index === total ? "（进入归档）" : `（放行 Phase ${phaseViews[phaseViews.findIndex(p => p.index === awaitingPhase.index) + 1]?.index ?? "?"}）`}
              </Button>
              {gate.fail > 0 && (
                <p className="text-[10px] text-pop-red" data-testid="acceptance-approve-blocked">✗ 未过 {gate.fail} 项 —— 通过被拦，请打回（反馈预填 + 票重开）</p>
              )}

              <Button
                variant="outline"
                className="h-auto w-full py-1.5 whitespace-normal text-center leading-snug"
                size="sm"
                disabled={busy !== null}
                onClick={openReject}
                data-acceptance-reject data-testid="acceptance-reject"
              >
                <Undo2 className="size-4 mr-1" /> 打回（写反馈）
              </Button>

              {/* 打回表单 v2.4：右列内联展开 → 独立弹窗（见文末 Dialog）。 */}

              <div className="space-y-1.5 border-t pt-2">
                <div className="flex items-baseline justify-between gap-2 text-[11px]" data-autoadvance-readonly data-testid="autoadvance-readonly">
                  <span className="text-muted-foreground">验收通过后自动开跑下一 Phase</span>
                  <span className={autoOn ? "text-pop-green" : "text-pop-amber"}>{autoOn ? "开" : "关（停在你的 gate）"}</span>
                </div>
                <p className="text-[10px] text-muted-foreground">此项在草稿期设定，验收阶段只读 —— 决定「通过」后下一 Phase 是自动开跑还是停在你手上</p>
              </div>

              <Button
                variant="destructive"
                size="sm"
                className="h-auto w-full py-1.5 whitespace-normal text-center leading-snug"
                disabled={busy !== null}
                onClick={requestAbort}
                data-acceptance-abort data-testid="acceptance-abort"
              >
                {busy === "abort" ? <Spinner className="size-4 mr-1" /> : <Ban className="size-4 mr-1" />}
                中止
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-acceptance-idle>
              {rejectedSeam ? "已打回 — 修复轮在跑（下方为路由回显）。" : "当前无待验收 round — 状态由 SSE 实时刷新。"}
            </p>
          )}

          {/* ── 打回提交后：本轮路由回显（ADR-0018，D13① 接缝已兑现） ── */}
          {rejectedSeam && (
            <div className="space-y-1 rounded-md border border-border bg-muted/30 p-2.5" data-agent-recommend-card data-testid="agent-recommend-card">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <Bot className="size-3.5" /> 已打回 Round {rejectedSeam.roundIndex} — 下一轮路由：
                {rejectedSeam.flow === "fix" ? "轻量修复（task-fix）" : "修订重跑（绑定流先再审 spec）"}
              </div>
              <p className="text-[10px] text-muted-foreground">
                反馈 {rejectedSeam.feedback.length} 字已落 fix-feedback-r{rejectedSeam.roundIndex}.md。
                {rejectedSeam.flow === "fix"
                  ? " task-fix 定点修复后会产 fix-report-rN.md 回批次目录。"
                  : " 执行侧在 workspace 里就地维护 spec 终态，collect 回流 task home（round-report 含 Spec 修订节）。"}
                路由仅作用本轮 — phase 绑定不变。
              </p>
            </div>
          )}

          {/* D14 影响清单（v4.1 接缝）已摘除：server 无 spec-r2 影响分析 API，
              items 恒空 —— 每次打回都亮一张「未上线」告示，只制造「这里坏了？」的
              疑惑。ImpactApprovalList 组件与单测保留，API 落地当天在 rejectedSeam 下接回。 */}
        </div>
        </div>

        {/* ── 主面：验货台（实物 | 核对）── */}
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col max-lg:order-none max-lg:min-h-[70vh] max-lg:border-b max-lg:border-border" data-acceptance-col-artifacts data-testid="acceptance-col-artifacts">
          {!awaitingPhase ? (
            <div className="space-y-2 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <FileText className="size-3.5" /> 验货台
              </div>
              <p className="text-[11px] text-muted-foreground" data-acceptance-batch-idle data-testid="acceptance-batch-idle">
                当前无待验收 round — 验收时在此验货（实物 diff / 当场复检 / 票对账）。
              </p>
            </div>
          ) : (
            <>
              {/* sub-tab 条：两枚 chunky 贴纸，选中的黄底压黑边（波普） */}
              <div className="flex shrink-0 items-center gap-1.5 border-b-2 border-pop-bd/10 bg-pop-paper px-3 py-2">
                {([
                  ["diff", "实物", roundDiff?.available ? String(roundDiff.aggregate.files) : ""],
                  ["matrix", "核对", ""],
                ] as const).map(([id, label, count]) => (
                  <button
                    key={id}
                    onClick={() => setMidTab(id)}
                    aria-selected={midTab === id}
                    className={`rounded-full border-[2px] px-3 py-0.5 font-mono text-[10.5px] font-black tracking-[.06em] transition-transform ${
                      midTab === id
                        ? "border-pop-bd bg-pop-yellow text-pop-ink shadow-pop-sm"
                        : "border-pop-bd/25 text-pop-dim hover:border-pop-bd/60"
                    }`}
                    data-acceptance-midtab={id} data-testid={`acceptance-tab-${id}`}
                  >
                    {label}{count && <span className="ml-1 tabular-nums opacity-70">{count}</span>}
                  </button>
                ))}

              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {midTab === "diff" && (
                  <>
                    <RoundDiffPanel
                      taskId={taskId ?? ""}
                      diff={diffScope === "round" ? roundDiff : cumDiff}
                      loading={diffScope === "round" ? diffLoading : cumLoading}
                      error={diffScope === "round" ? diffError : cumError}
                      onRetry={() => setDiffReload((v) => v + 1)}
                      scope={diffScope}
                      onScopeChange={setDiffScope}
                      canCumulative={fixPairRound >= 1}
                      roundIndex={awaitingRound?.roundIndex ?? null}
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
                    <PreviewBar
                      cfg={previewCfg}
                      runbook={runbookCfg}
                      preview={preview}
                      busy={previewBusy}
                      disabledReason={wsGone ? "工作区目录已不在 — 预览不可用" : undefined}
                      onSaveCfg={handlePreviewSave}
                      onSaveRunbook={handleRunbookSave}
                      onStart={() => void handlePreviewStart()}
                      onStop={() => void handlePreviewStop()}
                    />
                    <InstancesPanel
                      taskId={taskId ?? ""}
                      rev={(preview?.state ?? "stopped") + (awaitingPhase?.awaitingRound ?? 0)}
                      disabledReason={wsGone ? "工作区目录已不在 — 回收不可用" : undefined}
                    />
                    {playbook && (
                      <PlaybookPanel
                        taskId={taskId ?? ""}
                        batchRelDir={batchDir}
                        roundIndex={awaitingPhase?.awaitingRound ?? 0}
                        playbook={playbook}
                        onGate={setGate}
                        disabledReason={wsGone ? "工作区已清理 — 勾选暂停（历史台账/verdict 仍在）" : undefined}
                        saving={checksSaving}
                        onSaveStateChange={setChecksSaving}
                        registerFlush={registerPlaybookFlush}
                      />
                    )}
                  </>
                )}
                {midTab === "matrix" && (
                  <AcMatrixPanel
                    specMd={specMd === "" ? null : specMd}
                    specLoading={specLoading}
                    reportMd={roundReport}
                    diff={roundDiff}
                    fixReportMd={fixReportMd}
                    hasFixFeedback={!!fixFeedbackFile}
                  />
                )}
              </div>
            </>
          )}
        </div>


      </div>

      {/* 打回反馈弹窗（v2.4 用户裁决：右列内联展开别扭 → 独立弹窗输入；
          皮肤 = 全站贴纸 Dialog，与任务草稿窗同风格。路由二分（ADR-0018）照旧。 */}
      <Dialog
        open={rejectOpen}
        onOpenChange={(o) => { if (!o && busy !== "reject") setRejectOpen(false) }}
      >
        <DialogContent className="sm:max-w-[540px]" data-reject-dialog data-testid="reject-dialog">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {`打回 Phase ${awaitingPhase?.index ?? "?"} · Round ${awaitingPhase?.awaitingRound ?? "?"} — 写反馈`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3" data-reject-panel>
            <label className="text-[11px] font-medium text-pop-ink">
              打回反馈（必填 — 落 fix-feedback-r{awaitingPhase?.awaitingRound}.md）
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
            {/* ADR-0018 打回二分路由 — 下一 round 用哪条流（仅作用本轮，
                信封 phases[] 绑定冻结不破） */}
            <div className="space-y-1" data-reject-flow-group data-testid="reject-flow-group">
              <div className="text-[11px] font-medium text-pop-ink">下一轮路由</div>
              <label className="flex items-start gap-1.5 text-[11px] cursor-pointer" data-reject-flow="rerun">
                <input
                  type="radio" name="reject-flow" className="mt-0.5"
                  checked={nextFlow === "rerun"}
                  onChange={() => setNextFlow("rerun")}
                />
                <span>
                  <b>修订重跑</b>（重跑绑定流 · 默认）
                  <span className="block text-[10px] text-muted-foreground">绑定 matt-spec-dev 时流内先按反馈就地审查更新 spec，再整轮重执行</span>
                </span>
              </label>
              <label className="flex items-start gap-1.5 text-[11px] cursor-pointer" data-reject-flow="fix">
                <input
                  type="radio" name="reject-flow" className="mt-0.5"
                  checked={nextFlow === "fix"}
                  onChange={() => setNextFlow("fix")}
                />
                <span>
                  <b>轻量修复</b>（task-fix）
                  <span className="block text-[10px] text-muted-foreground">按反馈定点修 + fix-report，不重跑整个里程碑；规格级问题请改选修订重跑</span>
                </span>
              </label>
            </div>
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
                打回确认（开 Round {awaitingPhase?.awaitingRound != null ? awaitingPhase.awaitingRound + 1 : "?"} · {nextFlow === "fix" ? "轻量修复" : "修订重跑"}）
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 通过 · 台账预览确认（D8：这一眼就是最终产物，确认即机写不可改） */}
      <Dialog open={ledgerOpen} onOpenChange={(o) => { if (!o && busy !== "accept") setLedgerOpen(false) }}>
        <DialogContent className="sm:max-w-[560px]" data-testid="ledger-dialog">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {gate.undecided > 0
                ? `有 ${gate.undecided} 项走查未决 —— 确认跳过并放行？`
                : `全 ${gate.pass} 项走查 ✓ —— 确认验收通过？`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-[11.5px]">
            {playbook?.goal && <p className="font-semibold text-pop-ink">{playbook.goal}</p>}
            <div className="rounded-md border border-pop-bd/20 bg-pop-idle/30 p-2 font-mono text-[10.5px] leading-relaxed">
              <div>实物 · {roundDiff?.available ? `${roundDiff.aggregate.commits} commits · +${roundDiff.aggregate.additions}/−${roundDiff.aggregate.dels} · ${roundDiff.aggregate.files} 文件` : "无有效 diff"}</div>
              <div>自动复检 · {verify ? `${verify.state}${verify.exit_code != null ? ` (exit ${verify.exit_code})` : ""}` : "未跑（≠失败）"}</div>
              <div>跑起来看 · {preview && preview.state !== "stopped" ? `${previewStateLabel(preview.state)}${preview.url ? ` @ ${preview.url}` : ""}（决策时自动停止）` : "未使用"}</div>
              <div>人工走查 · ✓{gate.pass} · ✗{gate.fail} · ⊘{gate.skip} · 未决{gate.undecided} / 计{gate.total}</div>
            </div>
            {gate.skip > 0 && <p className="text-[10.5px] text-pop-amber">⊘ 跳过项将进入下一轮 carryover 首段（补验或再豁免），并写入台账。</p>}
            {gate.undecided > 0 && <p className="text-[10.5px] text-muted-foreground">未决项会以「未勾选」记入台账 —— 永久留痕。</p>}
            <p className="text-[10px] text-muted-foreground">确认后 server 机写 acceptance-ledger-r{awaitingPhase?.awaitingRound}.md 进批次目录（审计留痕，不可改）。</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLedgerOpen(false)}>再看看</Button>
            <Button size="sm" className="h-auto py-1.5 text-xs whitespace-normal leading-snug" disabled={busy !== null} onClick={() => void doAccept()} data-testid="ledger-confirm">
              {busy === "accept" ? <Spinner className="size-3 mr-1" /> : null}确认通过 · 写台账
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
