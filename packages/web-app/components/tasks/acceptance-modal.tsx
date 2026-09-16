// packages/web-app/components/tasks/acceptance-modal.tsx
//
// task-phase-redesign 票 12（K14/D11/US9-12）：v4 验收三栏证据面。
//
//   ┌ 左：执行摘要（round 用时 / 失败原因 / token / cost — fetchLLMCalls 聚合 +
//   │     本轮 run 由 executions[] 按 id 联查；TaskAiUsageCard 同等数据）
//   ├ 中：验货台（acceptance v2）— 三 tab：实物 | 核对 | 叙述
//   │     实物 = 待验收轮 start..end 的真实 git diff（RoundEvidenceService 服务端
//   │     解析,web 不见 SHA）+ 当场复检（acceptance_verify 命令在活工作区现跑,
//   │     task_verify/_log SSE 流式,PASS/FAIL 盖章,verdict .md 落批次目录）;
//   │     核对 = spec 票 × 报告声称 × diff 实物路径三方对账（lib/acceptance-matrix,
//   │     纯解析零 AI）; 叙述 = 批次目录直读（listHomeDir all=1 + round-report
//   │     内嵌 markdown + 「本轮」mtime 徽章 — v1 证据面整体降级收容于此）
//   └ 右：动作区（验收通过 / 打回[反馈必填] / 中止 + autoAdvance 只读态）
//
// 数据权威 = GET /:id 的 derived（票 03/07 唯一真相；票 11 已镜像类型）——
// 本组件只读 phaseViews，MUST NOT 重实现派生矩阵。提交走票 11 交付的
// postAcceptance（409=他处已决/态变 → 重拉 derived 刷新盘面；400=表单缺陷）。
//
// v4.1 接缝（票 12 Exploration 登记）：
//   ① D13① 打回二分路由（ADR-0018 已落地）：rejected 面板内人选「修订重跑」
//      （缺省，重跑绑定流 — matt-spec-dev 绑定即流内就地再审 spec）或
//      「轻量修复」（server override built-in/task-fix + 合成输入即时派发）。
//   ② D14 影响清单：server 无 spec-r2 impact API → ImpactApprovalList 渲染 +
//      批准写回逻辑就绪（updateSpecField phases 整数组），数据源为空态。
//      （collect→artifacts.json 的旧接缝③已兑现为直读：中列改盘扫批次目录，
//      server 读门同步放宽到 .scratch/** 全文件 + 512KB 上限。）

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Ban, Bot, CheckCircle2, FileText, FolderOpen, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskPhase, AcceptanceVerify } from "@octopus/shared"
import {
  PHASE_STATUS_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, TASK_STATUS_EVENT,
  TASK_VERIFY_EVENT, TASK_VERIFY_LOG_EVENT,
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
  type HomeFileListingEntry,
  type RoundDiffPayload,
  type VerifySummary,
  type VerifyState,
  type TaskDetail,
  type TaskPhaseView,
  type TaskRoundView,
} from "@/lib/tasks-api"
import { fetchLLMCalls } from "@/lib/observability-api"
import type { LLMCallAggregates } from "@/lib/types"
import { formatDuration, formatTokenCount, formatCost } from "@/lib/format"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { MarkdownPreview } from "@/components/resource/MarkdownPreview"
import { ArtifactViewerDialog, type HomeViewEntry } from "./authoring/artifact-viewer-dialog"
import { batchDirOf } from "./authoring/phase-spec-dialog"
import { isRelativeScratchSpec } from "./authoring/use-batch-tree"
import { RoundDiffPanel } from "./acceptance/round-diff-panel"
import { VerifyPanel } from "./acceptance/verify-panel"
import { AcMatrixPanel } from "./acceptance/ac-matrix-panel"
import { TaskAiUsageCard, runErrorOf } from "./execution-summary"

// 归档重试客户端 postArchiveRetry 位于 lib/tasks-api.ts（review ①: API 层惯例
// — 全部 client endpoint 住 tasks-api 单源；page.tsx 的「重试归档」按钮直连）。

// ── Props ────────────────────────────────────────────────────────────

export interface AcceptanceModalProps {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 看板刷新钩子（票 11 page.tsx 的 fetchTasks）。 */
  onMutated: () => void
}

const ROUND_STATE_LABEL: Record<string, string> = {
  pending: "排队中", running: "执行中", succeeded: "执行成功",
  failed: "执行失败", cancelled: "已取消/中止",
}

/** 中列不可预览扩展名（二进制/压缩 — 点开只会吐乱码或 413）。 */
const NON_PREVIEW_RE = /\.(db|sqlite3?|png|jpe?g|gif|webp|ico|zip|gz|zst|tar|pdf|wasm|mp4|webm|so|dylib|dll)$/i

/** K14 的「1 分钟决策成本」：三栏 grid，窄屏折叠为纵向。 */
export function AcceptanceModal({ task, open, onOpenChange, onMutated }: AcceptanceModalProps) {
  const taskId = task?.id ?? null
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  // 中列 = 本 phase 批次目录直读（task-exec-tree 验收证据面）：files 为 null
  // 表示未载/重载入中，[] 是「目录存在但无文件」或「目录未落盘(404)」。
  const [files, setFiles] = useState<HomeFileListingEntry[] | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [batchReload, setBatchReload] = useState(0) // SSE collect → bump 重拉
  const [homeViewing, setHomeViewing] = useState<HomeViewEntry | null>(null)
  const [roundReport, setRoundReport] = useState<string | null>(null)
  const [agg, setAgg] = useState<LLMCallAggregates | null>(null)
  const [aggLoading, setAggLoading] = useState(false)

  // 打回子块（右列展开）+ 提交后的路由回显/D14 接缝卡。
  const [rejectOpen, setRejectOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  // ADR-0018 打回二分路由：rerun=修订重跑（缺省，重跑绑定流）；fix=轻量修复(task-fix)。
  const [nextFlow, setNextFlow] = useState<"rerun" | "fix">("rerun")
  const [busy, setBusy] = useState<"accept" | "reject" | "abort" | null>(null)
  const [rejectedSeam, setRejectedSeam] = useState<{ phaseIndex: number; roundIndex: number; feedback: string; flow: "rerun" | "fix" } | null>(null)
  // specPath 绝对/缺失（gateV4 容忍 agent 旁路直写）时的批次定位回退位：
  // getBatchTree 按 slug 取 latest_mtime 最新 dir（specPath 优先,正常 v4 恒命中）。
  // tried 区分「还在扫」与「扫完没有」——防中列无限转圈。
  const [fallbackDir, setFallbackDir] = useState<string | null>(null)
  const [fallbackTried, setFallbackTried] = useState(false)
  // ── 验货台 (acceptance v2) 状态 ──
  // midTab：实物(默认=C位) | 核对 | 叙述；roundDiff=真实提交区间；verify=当场复检。
  const [midTab, setMidTab] = useState<"diff" | "matrix" | "story">("diff")
  const [roundDiff, setRoundDiff] = useState<RoundDiffPayload | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffReload, setDiffReload] = useState(0) // 实物面板「重试」
  const [specMd, setSpecMd] = useState<string | null>(null) // 核对 tab 懒拉;"" = 不存在
  const [specLoading, setSpecLoading] = useState(false)
  const [verify, setVerify] = useState<VerifySummary | null>(null)
  const [verifyLines, setVerifyLines] = useState<string[]>([])
  const [verifyBusy, setVerifyBusy] = useState(false)

  const refetchDetail = useCallback(() => {
    if (!taskId) return
    getTask(taskId).then(setDetail).catch(() => { /* keep last snapshot */ })
  }, [taskId])

  // 开窗：拉 detail（批次文件列表由 [open, batchDir] 的下行 effect 拉，detail
  // 到手才知道 batchDir）；复位打回子块。
  useEffect(() => {
    if (!open || !taskId) return
    setDetail(null)
    setRejectOpen(false)
    setFeedback("")
    setNextFlow("rerun")
    setRejectedSeam(null)
    setFiles(null)
    setBatchError(null)
    setRoundReport(null)
    setFallbackDir(null)
    setFallbackTried(false)
    setMidTab("diff")
    setRoundDiff(null)
    setDiffError(null)
    setSpecMd(null)
    setVerify(null)
    setVerifyLines([])
    refetchDetail()
  }, [open, taskId, refetchDetail])

  // SSE 挂窗（K14「无需刷新」）：phase_status_update / task_status → 重拉派生；
  // task_artifacts_update → 重拉批次列表（票 06 collect 轮终态上行即推 — 中列
  // 的证据就是这个事件带回来的）。
  useEffect(() => {
    if (!open || !taskId) return
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (e: MessageEvent): boolean => {
      try {
        return (JSON.parse(e.data) as { task_id?: string }).task_id === taskId
      } catch {
        return false
      }
    }
    const unPhase = subscribeSSE(url, PHASE_STATUS_UPDATE_EVENT, (e) => { if (mine(e)) refetchDetail() })
    const unStatus = subscribeSSE(url, TASK_STATUS_EVENT, (e) => { if (mine(e)) refetchDetail() })
    const unArts = subscribeSSE(url, TASK_ARTIFACTS_UPDATE_EVENT, (e) => { if (mine(e)) setBatchReload((v) => v + 1) })
    // 验货台复检：逐行进控制台（client cap 2000；重连由 GET /:id/verify tail 兜底），
    // 终态合并进 summary（stamp/verdict 指针都读 summary.state，不另设标志位）。
    const unVLog = subscribeSSE(url, TASK_VERIFY_LOG_EVENT, (e) => {
      if (!mine(e)) return
      try {
        const d = JSON.parse(e.data) as { line?: string; stream?: string }
        if (typeof d.line !== "string") return
        const line = d.stream === "stderr" ? `[stderr] ${d.line}` : d.line
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
    return () => { unPhase(); unStatus(); unArts(); unVLog(); unVerify() }
  }, [open, taskId, refetchDetail])

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

  // round 的 AI 消耗（execution 口径，非任务合计口径 — 票 12 左列）。
  const execId = awaitingRound?.exec.id ?? null
  useEffect(() => {
    if (!open || !execId) { setAgg(null); return }
    let cancelled = false
    setAggLoading(true)
    fetchLLMCalls(execId)
      .then((r) => { if (!cancelled) setAgg(r.aggregates ?? null) })
      .catch(() => { if (!cancelled) setAgg(null) })
      .finally(() => { if (!cancelled) setAggLoading(false) })
    return () => { cancelled = true }
  }, [open, execId])

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
    if (!open || !taskId || !awaitingPhase || specBatchDir) { setFallbackDir(null); return }
    let cancelled = false
    getBatchTree(taskId)
      .then((bs) => {
        if (cancelled) return
        const hit = bs
          .filter((b) => b.slug === awaitingPhase.slug)
          .sort((a, b) => (a.latest_mtime < b.latest_mtime ? 1 : a.latest_mtime > b.latest_mtime ? -1 : 0))[0]
        setFallbackDir(hit?.dir ?? null)
        setFallbackTried(true)
      })
      .catch(() => { if (!cancelled) { setFallbackDir(null); setFallbackTried(true) } })
    return () => { cancelled = true }
  }, [open, taskId, awaitingPhase, specBatchDir])
  const batchDir = specBatchDir ?? fallbackDir

  useEffect(() => {
    if (!open || !taskId || !batchDir) return
    let cancelled = false
    setFiles(null)
    setBatchError(null)
    listHomeDir(taskId, batchDir, { all: true })
      .then((fs) => { if (!cancelled) { setFiles(fs); setBatchError(null) } })
      .catch((err: unknown) => {
        if (cancelled) return
        // 目录未落盘（首轮 collect 前）= 正常空态；其余（server 未更新 403 等）显式报错
        if (err instanceof TaskApiError && err.status === 404) setFiles([])
        else setBatchError(err instanceof Error ? err.message : "批次目录读取失败")
      })
    return () => { cancelled = true }
  }, [open, taskId, batchDir, batchReload])

  // round 时间窗（「本轮」徽章判据）：seed/collect 双向保留 mtime
  // (task-artifact-sync 设计不变式) → mtime ∈ [started_at??created_at, completed_at]
  // 即"本轮执行侧动过的文件"。依赖同机时钟（dev 单机部署,注释即裁决）。running 轮
  // 无上界 → now,SSE 重拉时徽章随盘更新。roundRun 联查不到（server 老/列表缺）→ 无徽章。
  const roundWindow = useMemo(() => {
    if (!roundRun) return null
    const lo = Date.parse(roundRun.started_at ?? roundRun.created_at)
    if (Number.isNaN(lo)) return null
    const hi = roundRun.completed_at ? Date.parse(roundRun.completed_at) : Date.now()
    return { lo, hi }
  }, [roundRun])
  const inRound = useCallback((f: HomeFileListingEntry): boolean =>
    !!roundWindow && Date.parse(f.mtime) >= roundWindow.lo && Date.parse(f.mtime) <= roundWindow.hi,
  [roundWindow])

  // 不可预览预门控：二进制/压缩类扩展名 + 超读上限（server 413 的镜像,避免
  // 点开才见错误）。.db 仍展示 —— 证据存在性本身就是决策信息。
  const previewable = useCallback(
    (f: HomeFileListingEntry): boolean => !NON_PREVIEW_RE.test(f.path) && f.bytes <= MAX_HOME_FILE_READ_BYTES,
    [],
  )

  // 内嵌 round-report：固定文件名、每轮覆写（task-author SKILL 约定;fix 轮的
  // fix-report-rN.md 是普通可点行）。mtime 进 deps → collect 覆写后自动重拉。
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

  const sortedFiles = useMemo(
    () => (files ?? []).slice().sort((a, b) => (a.mtime === b.mtime ? 0 : a.mtime < b.mtime ? 1 : -1)),
    [files],
  )

  // ── 验货台数据流（acceptance v2） ──────────────────────────────────────
  // 实物 diff：按 awaiting 轮现拉（服务端解析 commit 区间；409 无 awaiting = 静默
  // null —— 面板本身有 idle 态）。exec id 变化（换轮/重开）即重拉。
  const awaitingExecId = awaitingRound?.exec.id ?? ""
  useEffect(() => {
    if (!open || !taskId || !awaitingExecId) { setRoundDiff(null); setDiffError(null); return }
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
  }, [open, taskId, awaitingExecId, diffReload])

  // 复检会话恢复：开窗 GET 一次（SSE 无 replay，tail 由 GET 承载；501/离线 = null）。
  useEffect(() => {
    if (!open || !taskId || !awaitingExecId) return
    let cancelled = false
    getVerifyStatus(taskId)
      .then((s) => {
        if (cancelled || !s) return
        setVerify(s)
        if (s.tail?.length) setVerifyLines(s.tail)
      })
      .catch(() => { /* 未装配/离线 — 无会话可恢复 */ })
    return () => { cancelled = true }
  }, [open, taskId, awaitingExecId])

  // 核对 tab 的 spec.md：首访懒拉，"" 缓存「不存在」防重拉风暴。
  useEffect(() => {
    if (!open || !taskId || !batchDir || midTab !== "matrix" || specMd !== null || specLoading) return
    let cancelled = false
    setSpecLoading(true)
    getHomeFile(taskId, `${batchDir}/spec.md`)
      .then((r) => { if (!cancelled) setSpecMd(r.content) })
      .catch(() => { if (!cancelled) setSpecMd("") })
      .finally(() => { if (!cancelled) setSpecLoading(false) })
    return () => { cancelled = true }
  }, [open, taskId, batchDir, midTab, specMd, specLoading])

  const verifyCfg = (detail?.task_spec ?? task?.task_spec)?.acceptance_verify ?? null
  const verifyRunning = verify?.state === "running"
  const wsGone = roundDiff !== null && !roundDiff.available && roundDiff.reason === "no_workspace"
  const verifyDisabled = wsGone
    ? "工作区目录已不在 — 当场复检不可用（叙述/历史 verdict 仍可看）"
    : undefined

  const handleVerifyRun = useCallback(async () => {
    if (!taskId) return
    setVerifyBusy(true)
    try {
      const s = await startVerify(taskId)
      setVerify(s)
      setVerifyLines([])
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

  // ── 前序交接提示行（phase-handoff-chaining 票 04 / spec K6） ──────────
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

  const handleAccept = useCallback(async () => {
    if (!task || !awaitingPhase || awaitingPhase.awaitingRound == null || busy) return
    setBusy("accept")
    try {
      const result = await postAcceptance(task.id, {
        phase_index: awaitingPhase.index,
        round_index: awaitingPhase.awaitingRound,
        decision: "accepted",
      })
      onMutated()
      const n = result.task.derived?.phaseViews.length ?? phaseViews.length
      switch (result.next_action) {
        case "archiving":
          toast.success("末 Phase 已通过 — 归档编排中（全绿才 done）")
          break
        case "awaiting_manual_trigger":
          toast.success(`Phase ${awaitingPhase.index}/${n} 已通过 — autoAdvance 关闭，下一 Phase 停在你的 gate（看板卡片「启动下一 Phase」）`)
          break
        default:
          toast.success(`Phase ${awaitingPhase.index}/${n} 已通过 — 下一 Phase 已自动开跑`)
      }
      onOpenChange(false)
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
  }, [task, awaitingPhase, busy, onMutated, onOpenChange, phaseViews.length, refetchDetail])

  const handleReject = useCallback(async () => {
    const trimmed = feedback.trim()
    if (!task || !awaitingPhase || awaitingPhase.awaitingRound == null || !trimmed || busy) return
    setBusy("reject")
    try {
      const result = await postAcceptance(task.id, {
        phase_index: awaitingPhase.index,
        round_index: awaitingPhase.awaitingRound,
        decision: "rejected",
        feedback: trimmed,
        next_flow: nextFlow, // ADR-0018 二分路由（round 级，只作用下一轮）
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
      setDetail(result.task)
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
  }, [task, awaitingPhase, feedback, nextFlow, busy, onMutated, refetchDetail])

  const handleAbort = useCallback(async () => {
    if (!task || busy) return
    setBusy("abort")
    try {
      await abortTask(task.id)
      toast.success("已中止任务，工作区将清理")
      onMutated()
      onOpenChange(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "中止失败")
      refetchDetail()
    } finally {
      setBusy(null)
    }
  }, [task, busy, onMutated, onOpenChange, refetchDetail])

  // autoAdvance 只读态（开关本体在 AuthoringWorkspace — 编辑仅 draft/ready 合法）。
  const autoOn = (detail?.task_spec ?? task?.task_spec)?.autoAdvance !== false

  const total = phaseViews.length

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton
          className="sm:max-w-[1180px] w-[95vw] max-h-[90vh] h-[86vh] p-0 gap-0 flex flex-col"
          aria-describedby={undefined}
          data-acceptance-modal data-testid="acceptance-modal"
        >
          <DialogHeader className="px-5 py-3 border-b shrink-0 space-y-0">
            <DialogTitle className="text-sm flex items-center gap-2">
              验收
              {awaitingPhase && (
                <span className="text-xs font-normal text-muted-foreground tabular-nums" data-acceptance-phase-label data-testid="acceptance-phase-label">
                  {`Phase ${awaitingPhase.index}/${total} · Round ${awaitingPhase.awaitingRound}`}
                </span>
              )}
              {task && <Badge variant="outline" className="text-[10px] max-w-[260px] truncate">{task.name}</Badge>}
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              验货台（K14 升级）：执行摘要 | 实物 · 核对 · 叙述 | 动作区 — 验收 = 验货，不是读汇报
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr_320px]">
            {/* ── 左：执行摘要 ── */}
            <div className="min-h-0 border-r border-border overflow-y-auto p-4 space-y-3" data-acceptance-col-summary data-testid="acceptance-col-summary">
              <div className="text-xs font-semibold text-muted-foreground">执行摘要</div>
              {!detail ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> 读取派生视图…</div>
              ) : !awaitingRound ? (
                <p className="text-xs text-muted-foreground" data-acceptance-no-round>
                  {rejectedSeam
                    ? `本 Phase 已打回（Round ${rejectedSeam.roundIndex}）— 修复轮在跑。`
                    : "当前无待验收 round。"}
                </p>
              ) : (
                <>
                  <div className="space-y-1 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs">Phase</span>
                      <span className="font-medium truncate">{awaitingPhase?.index}/{total} · {awaitingPhase?.name}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs">Round</span>
                      <span className="tabular-nums">R{awaitingRound.roundIndex}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs">Workflow</span>
                      <code className="text-[11px] truncate max-w-[170px]">{awaitingPhase?.workflowRef || "—"}</code>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs">执行结果</span>
                      <span
                        data-acceptance-round-state={awaitingRound.state} data-testid="acceptance-round-state"
                        className={
                          awaitingRound.state === "succeeded" ? "text-pop-green"
                            : awaitingRound.state === "failed" ? "text-pop-amber" // US8: 失败=待处理，不是红死
                              : "text-muted-foreground"
                        }
                      >
                        {ROUND_STATE_LABEL[awaitingRound.state] ?? awaitingRound.state}
                      </span>
                    </div>
                    {/* 票05: 红轮的一行原因（error_summary 出口之一 —— 验收面是它最该
                        被看到的地方）。绿轮/无原因 → 不渲染。 */}
                    {roundError && (
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-muted-foreground text-xs shrink-0">失败原因</span>
                        <span className="text-pop-amber text-xs text-right break-words" data-acceptance-round-error data-testid="acceptance-round-error">
                          {roundError}
                        </span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs">用时</span>
                      <span className="tabular-nums" data-acceptance-duration data-testid="acceptance-duration">
                        {durationMs != null ? formatDuration(durationMs) : "—"}
                      </span>
                    </div>
                  </div>
                  {/* token/cost：TaskAiUsageCard 同等数据（round 口径注入） */}
                  <TaskAiUsageCard agg={agg} loading={aggLoading} runCount={execId ? 1 : 0} />
                </>
              )}
            </div>

            {/* ── 中：验货台（实物 | 核对 | 叙述） ── */}
            <div className="min-h-0 border-r border-border flex flex-col" data-acceptance-col-artifacts data-testid="acceptance-col-artifacts">
              {!awaitingPhase ? (
                <div className="p-4 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                    <FileText className="size-3.5" /> 验货台
                  </div>
                  <p className="text-[11px] text-muted-foreground" data-acceptance-batch-idle data-testid="acceptance-batch-idle">
                    当前无待验收 round — 验收时在此验货（实物 diff / 当场复检 / 票对账）。
                  </p>
                </div>
              ) : (
                <>
                  {/* tab 条：三枚 chunky 贴纸，选中的黄底压黑边（波普） */}
                  <div className="shrink-0 flex items-center gap-1.5 border-b-2 border-pop-bd/10 bg-pop-paper px-3 py-2">
                    {([
                      ["diff", "实物", roundDiff?.available ? String(roundDiff.aggregate.files) : ""],
                      ["matrix", "核对", ""],
                      ["story", "叙述", files ? String(files.length) : ""],
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

                  <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                    {midTab === "diff" && (
                      <>
                        <RoundDiffPanel
                          taskId={taskId ?? ""}
                          diff={roundDiff}
                          loading={diffLoading}
                          error={diffError}
                          onRetry={() => setDiffReload((v) => v + 1)}
                        />
                        <VerifyPanel
                          cfg={verifyCfg}
                          summary={verify}
                          lines={verifyLines}
                          running={!!verifyRunning}
                          busy={verifyBusy}
                          disabledReason={verifyDisabled}
                          onSaveCommand={handleVerifySave}
                          onRun={() => void handleVerifyRun()}
                          onAbort={() => void handleVerifyAbort()}
                        />
                      </>
                    )}
                    {midTab === "matrix" && (
                      <AcMatrixPanel
                        specMd={specMd === "" ? null : specMd}
                        specLoading={specLoading}
                        reportMd={roundReport}
                        diff={roundDiff}
                      />
                    )}
                    {midTab === "story" && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                          <FileText className="size-3.5" /> 叙述材料（批次目录直读）
                          <span className="ml-auto font-normal">
                            {`批次 slug: ${awaitingPhase.slug}`}{batchDir ? ` · ${batchDir}` : ""}{files ? ` · ${files.length} 个` : ""} · 点击看全文
                          </span>
                        </div>

                        {/* agent 自述主文档内嵌渲染（v1 语义保留）：round-report.md
                            markdown 直出，列表在其下 — 其余文件点开全文看。 */}
                        {roundReport && (
                          <div className="rounded-md border border-border bg-muted/20 space-y-1" data-acceptance-round-report data-testid="acceptance-round-report">
                            <div className="px-3 pt-2 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                              <FileText className="size-3" /> round-report.md · agent 自述
                            </div>
                            <div className="px-3 pb-2 max-h-[420px] overflow-y-auto">
                              <MarkdownPreview content={roundReport} className="text-[11px]" />
                            </div>
                          </div>
                        )}

                        {batchError && (
                          <div className="text-[11px] text-pop-red" data-acceptance-batch-error data-testid="acceptance-batch-error">
                            批次目录读取失败：{batchError}
                          </div>
                        )}
                        {files === null && !batchError && (batchDir || !fallbackTried) && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Spinner className="size-3" /> {batchDir ? "读取批次目录…" : "定位批次目录…"}
                          </div>
                        )}
                        {((files !== null && files.length === 0) ||
                          (files === null && !batchError && !batchDir && fallbackTried)) && (
                          <div className="rounded-md border border-dashed p-4 text-[11px] text-muted-foreground" data-acceptance-batch-empty data-testid="acceptance-batch-empty">
                            {`本 Phase 批次目录${batchDir ? `（${batchDir}）` : ""}暂无文件 — round 终态 collect 回收执行侧改动后即时出现。`}
                          </div>
                        )}
                        {sortedFiles.length > 0 && (
                          <ul className="space-y-1.5" data-acceptance-artifact-rows data-testid="acceptance-artifact-rows">
                            {sortedFiles.map((f) => {
                              const name = f.path.split("/").pop() ?? f.path
                              const canPreview = previewable(f)
                              const badge = inRound(f)
                              return (
                                <li key={f.path}>
                                  <button
                                    className={`w-full text-left rounded-md border px-2.5 py-1.5 transition-colors ${
                                      canPreview ? "border-border hover:border-primary/40" : "border-border/50 opacity-60 cursor-default"
                                    }`}
                                    disabled={!canPreview}
                                    onClick={() => canPreview && setHomeViewing({ path: f.path, bytes: f.bytes, mtime: f.mtime })}
                                    data-acceptance-artifact-row={f.path} data-testid={`acceptance-artifact-row-${f.path}`}
                                  >
                                    <div className="flex items-center gap-2">
                                      <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
                                      <span className="text-sm truncate">{name}</span>
                                      {badge && (
                                        <Badge className="text-[9px] px-1 py-0 shrink-0" data-acceptance-round-badge={f.path} data-testid={`acceptance-round-badge-${f.path}`}>
                                          本轮
                                        </Badge>
                                      )}
                                      <span className="ml-auto text-[10px] text-muted-foreground shrink-0 tabular-nums">{f.mtime.slice(5, 16).replace("T", " ")}</span>
                                    </div>
                                    <div className="text-[11px] text-muted-foreground truncate mt-0.5 font-mono">
                                      {f.path} · {Math.max(1, Math.round(f.bytes / 1024))} KB
                                      {!canPreview && <span className="text-pop-amber"> · 不可预览</span>}
                                    </div>
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── 右：动作区 ── */}
            <div className="min-h-0 overflow-y-auto p-4 space-y-3" data-acceptance-col-actions data-testid="acceptance-col-actions">
              <div className="text-xs font-semibold text-muted-foreground">动作区</div>

              {awaitingPhase ? (
                <>
                  {hasNextPhase && !rejectOpen && (
                    <p className="text-[10px] text-muted-foreground" data-handoff-hint data-testid="handoff-hint">
                      {`本 phase 的 handoff.md 连同已 accepted 共 ${handoffCount} 个前序交接，将自动进入下一 phase 执行会话`}
                    </p>
                  )}
                  <Button
                    className="w-full"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void handleAccept()}
                    data-acceptance-approve data-testid="acceptance-approve"
                  >
                    {busy === "accept" ? <Spinner className="size-4 mr-1" /> : <CheckCircle2 className="size-4 mr-1" />}
                    验收通过{awaitingPhase.index === total ? "（进入归档）" : `（放行 Phase ${phaseViews[phaseViews.findIndex(p => p.index === awaitingPhase.index) + 1]?.index ?? "?"}）`}
                  </Button>

                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setRejectOpen((v) => !v)}
                    data-acceptance-reject data-testid="acceptance-reject"
                  >
                    <Undo2 className="size-4 mr-1" /> 打回（写反馈）
                  </Button>

                  {rejectOpen && (
                    <div className="rounded-md border border-pop-amber/40 bg-pop-amber-soft p-2.5 space-y-2" data-reject-panel>
                      <label className="text-[11px] font-medium text-pop-ink">
                        打回反馈（必填 — 落 fix-feedback-r{awaitingPhase.awaitingRound}.md）
                      </label>
                      <Textarea
                        rows={4}
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="哪里不对 / 期望怎么修 — agent 修复轮以此为输入"
                        className="text-xs"
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
                          className="h-6 text-[10px]"
                          disabled={!feedback.trim() || busy !== null}
                          onClick={() => void handleReject()}
                          data-reject-confirm data-testid="reject-confirm"
                        >
                          {busy === "reject" ? <Spinner className="size-3 mr-1" /> : null}
                          打回确认（开 Round {awaitingPhase.awaitingRound != null ? awaitingPhase.awaitingRound + 1 : "?"} · {nextFlow === "fix" ? "轻量修复" : "修订重跑"}）
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="pt-2 border-t space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-[11px]" data-autoadvance-readonly data-testid="autoadvance-readonly">
                      <span className="text-muted-foreground">验收通过后自动开跑下一 Phase</span>
                      <span className={autoOn ? "text-pop-green" : "text-pop-amber"}>{autoOn ? "开" : "关（停在你的 gate）"}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">开关在草稿面板（入队清单下方）</p>
                  </div>

                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    disabled={busy !== null}
                    onClick={() => void handleAbort()}
                    data-acceptance-abort data-testid="acceptance-abort"
                  >
                    {busy === "abort" ? <Spinner className="size-4 mr-1" /> : <Ban className="size-4 mr-1" />}
                    中止
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground" data-acceptance-idle>
                  {rejectedSeam ? "已打回 — 修复轮在跑（右下方为形态推荐/影响清单接缝）。" : "当前无待验收 round — 状态由 SSE 实时刷新。"}
                </p>
              )}

              {/* ── 打回提交后：本轮路由回显（ADR-0018，D13① 接缝已兑现） ── */}
              {rejectedSeam && (
                <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1" data-agent-recommend-card data-testid="agent-recommend-card">
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

              {/* ── D14 影响清单（渲染逻辑就绪 / 数据源空态 = v4.1 接缝） ── */}
              {rejectedSeam && task && (
                <ImpactApprovalList
                  taskId={task.id}
                  phases={(detail?.task_spec ?? task.task_spec).phases ?? []}
                  items={[]}
                  onDone={() => { refetchDetail(); onMutated() }}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ArtifactViewerDialog
        taskId={taskId ?? ""}
        entry={null}
        homeEntry={homeViewing}
        onOpenChange={(o) => { if (!o) setHomeViewing(null) }}
      />
    </>
  )
}

// ── 影响清单（D14 批准→spec-field phases 写回；数据源 = v4.1 接缝）───

export interface PhaseImpactItem {
  /** 稳定 key（决策行号/编号，K8「Key Decisions 行 diff」产物）。 */
  key: string
  /** 受影响的后续 phase（1-based index）。 */
  phaseIndex: number
  /** spec 连带修订说明。 */
  change: string
  /** workflow 重估建议说明（人一眼可读）。 */
  workflowReassess?: string
  /** 批准后写入该 phase 的新 workflowRef（可选）。 */
  nextWorkflowRef?: string
}

export interface ImpactApprovalListProps {
  taskId: string
  /** 当前 phases（写回时整数组替换受影响项）。 */
  phases: TaskPhase[]
  /** server 影响分析产物 — 当前恒空（v4.1 接缝），渲染/写回逻辑就绪。 */
  items: PhaseImpactItem[]
  onDone: () => void
}

export function ImpactApprovalList({ taskId, phases, items, onDone }: ImpactApprovalListProps) {
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-2.5 space-y-1" data-impact-list-empty data-testid="impact-list-empty">
        <div className="text-[11px] font-semibold text-muted-foreground">决策影响清单</div>
        <p className="text-[10px] text-muted-foreground">
          暂无条目 — server 的 spec-r2 影响分析 API 未上线（D14，v4.1 接缝）。勾选 + 批准改写
          phases（workflow 重估连带）的渲染与写回逻辑已就绪：批准 = updateSpecField(phases 整数组)。
        </p>
      </div>
    )
  }

  const toggle = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleApprove = async () => {
    if (busy || checkedKeys.size === 0) return
    setBusy(true)
    try {
      // 批准 → 按勾选条目改写受影响 phase（workflow 重估建议落地为该行 nextWorkflowRef），
      // 整数组 spec-field 写回（票 07 AC5 语义：version bump + spec_field_update SSE）。
      const byPhase = new Map<number, PhaseImpactItem[]>()
      for (const it of items) {
        if (!checkedKeys.has(it.key)) continue
        byPhase.set(it.phaseIndex, [...(byPhase.get(it.phaseIndex) ?? []), it])
      }
      const nextPhases: TaskPhase[] = phases.map((p) => {
        const hits = byPhase.get(p.index)
        if (!hits) return p
        const ref = hits.map((h) => h.nextWorkflowRef).filter(Boolean).pop()
        return ref ? { ...p, workflowRef: ref as TaskPhase["workflowRef"] } : p
      })
      await updateSpecField(taskId, "phases", nextPhases, { source: "user" })
      toast.success(`影响清单已批准 — ${checkedKeys.size} 条修订写入 phases（spec-r2 传播）`)
      setCheckedKeys(new Set())
      onDone()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "影响清单批准失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border border-pop-purple/40 bg-pop-purple-soft p-2.5 space-y-2" data-impact-list>
      <div className="text-[11px] font-semibold text-muted-foreground">决策影响清单（批准即改写后续 phase）</div>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.key}>
            <label className="flex items-start gap-1.5 text-[11px] cursor-pointer" data-impact-item={it.key} data-testid={`impact-item-${it.key}`}>
              <input
                type="checkbox"
                checked={checkedKeys.has(it.key)}
                onChange={() => toggle(it.key)}
                className="mt-0.5"
              />
              <span>
                <b>Phase {it.phaseIndex}</b> · {it.change}
                {it.workflowReassess && <span className="block text-[10px] text-muted-foreground">workflow 重估：{it.workflowReassess}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button size="sm" className="h-6 text-[10px]" disabled={checkedKeys.size === 0 || busy} onClick={() => void handleApprove()} data-impact-approve data-testid="impact-approve">
          {busy ? <Spinner className="size-3 mr-1" /> : null}
          批准并改写（{checkedKeys.size}）
        </Button>
      </div>
    </div>
  )
}
