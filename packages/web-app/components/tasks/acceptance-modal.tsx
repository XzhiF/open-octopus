// packages/web-app/components/tasks/acceptance-modal.tsx
//
// task-phase-redesign 票 12（K14/D11/US9-12）：v4 验收三栏证据面。
//
//   ┌ 左：执行摘要（round 用时 / token / cost — fetchLLMCalls 聚合 + children
//   │     execution_ref 联查；TaskAiUsageCard 同等数据）
//   ├ 中：产物核对（本 phase 批次文件 → 既有 ArtifactViewerDialog 展开全文；
//   │     task_artifacts_update SSE 挂窗即时刷新 — 票 06 collect 上行）
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
//   ③ collect 落 home/.scratch 但不登记 artifacts.json → 中列对批次文件是
//      「登记可见」语义（登记即出现，未登记则空态），自动登记归 server。

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
import type { ArtifactIndexEntry, Task, TaskPhase } from "@octopus/shared"
import { PHASE_STATUS_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, TASK_STATUS_EVENT } from "@octopus/shared"
import {
  abortTask,
  getTask,
  listArtifacts,
  postAcceptance,
  updateSpecField,
  TaskApiError,
  type TaskDetail,
  type TaskPhaseView,
  type TaskRoundView,
} from "@/lib/tasks-api"
import { fetchLLMCalls } from "@/lib/observability-api"
import type { LLMCallAggregates } from "@/lib/types"
import { formatDuration, formatTokenCount, formatCost } from "@/lib/format"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { ArtifactViewerDialog } from "./authoring/artifact-viewer-dialog"
import { TaskAiUsageCard } from "./execution-summary"

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

/** K14 的「1 分钟决策成本」：三栏 grid，窄屏折叠为纵向。 */
export function AcceptanceModal({ task, open, onOpenChange, onMutated }: AcceptanceModalProps) {
  const taskId = task?.id ?? null
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactIndexEntry[]>([])
  const [viewing, setViewing] = useState<ArtifactIndexEntry | null>(null)
  const [agg, setAgg] = useState<LLMCallAggregates | null>(null)
  const [aggLoading, setAggLoading] = useState(false)

  // 打回子块（右列展开）+ 提交后的路由回显/D14 接缝卡。
  const [rejectOpen, setRejectOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  // ADR-0018 打回二分路由：rerun=修订重跑（缺省，重跑绑定流）；fix=轻量修复(task-fix)。
  const [nextFlow, setNextFlow] = useState<"rerun" | "fix">("rerun")
  const [busy, setBusy] = useState<"accept" | "reject" | "abort" | null>(null)
  const [rejectedSeam, setRejectedSeam] = useState<{ phaseIndex: number; roundIndex: number; feedback: string; flow: "rerun" | "fix" } | null>(null)

  const refetchDetail = useCallback(() => {
    if (!taskId) return
    getTask(taskId).then(setDetail).catch(() => { /* keep last snapshot */ })
  }, [taskId])

  const refetchArtifacts = useCallback(() => {
    if (!taskId) return
    listArtifacts(taskId).then(setArtifacts).catch(() => setArtifacts([]))
  }, [taskId])

  // 开窗：拉 detail + artifacts；复位打回子块。
  useEffect(() => {
    if (!open || !taskId) return
    setDetail(null)
    setRejectOpen(false)
    setFeedback("")
    setNextFlow("rerun")
    setRejectedSeam(null)
    refetchDetail()
    refetchArtifacts()
  }, [open, taskId, refetchDetail, refetchArtifacts])

  // SSE 挂窗（K14「无需刷新」）：phase_status_update / task_status → 重拉派生；
  // task_artifacts_update → 重拉产物索引（票 06 collect 上行即推）。
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
    const unArts = subscribeSSE(url, TASK_ARTIFACTS_UPDATE_EVENT, (e) => { if (mine(e)) refetchArtifacts() })
    return () => { unPhase(); unStatus(); unArts() }
  }, [open, taskId, refetchDetail, refetchArtifacts])

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

  // 用时：children[].execution_ref 与 round.exec.id 联查（derived 无 completed_at）。
  const durationMs: number | null = useMemo(() => {
    if (!awaitingRound || !detail?.children) return null
    const ref = detail.children
      .map((c) => c.execution_ref)
      .find((r) => r?.execution_id === awaitingRound.exec.id)
    if (!ref) return null
    if (ref.duration_ms != null) return ref.duration_ms
    if (ref.completed_at) return Math.max(0, Date.parse(ref.completed_at) - Date.parse(ref.triggered_at))
    return null
  }, [awaitingRound, detail])

  const errorSummary = useMemo(() => {
    if (!awaitingRound || !detail?.children) return null
    const ref = detail.children
      .map((c) => c.execution_ref)
      .find((r) => r?.execution_id === awaitingRound.exec.id)
    return ref?.error_summary ?? null
  }, [awaitingRound, detail])

  // 产物核对：登记产物里命中本 phase slug 的文件（K10 批次目录
  // `.scratch/<date>/<slug>/`，登记可见语义 — 接缝③）。
  const phaseArtifacts = useMemo(() => {
    const slug = awaitingPhase?.slug ?? (rejectedSeam ? "" : "")
    if (!slug) return artifacts
    const hit = artifacts.filter((a) => a.path.includes(slug))
    return hit.length > 0 ? hit : artifacts
  }, [artifacts, awaitingPhase, rejectedSeam])

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
              三栏证据面（K14）：执行摘要 | 产物核对 | 动作区 — 1 分钟决策成本
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
                          awaitingRound.state === "succeeded" ? "text-emerald-600"
                            : awaitingRound.state === "failed" ? "text-amber-600" // US8: 失败=待处理，不是红死
                              : "text-muted-foreground"
                        }
                      >
                        {ROUND_STATE_LABEL[awaitingRound.state] ?? awaitingRound.state}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs">用时</span>
                      <span className="tabular-nums" data-acceptance-duration data-testid="acceptance-duration">
                        {durationMs != null ? formatDuration(durationMs) : "—"}
                      </span>
                    </div>
                  </div>
                  {errorSummary && (
                    <p className="text-xs text-amber-600 break-words whitespace-pre-wrap rounded-md border border-amber-400/40 bg-amber-500/5 p-2" data-acceptance-error>
                      {errorSummary}
                    </p>
                  )}
                  {/* token/cost：TaskAiUsageCard 同等数据（round 口径注入） */}
                  <TaskAiUsageCard agg={agg} loading={aggLoading} runCount={execId ? 1 : 0} />
                </>
              )}
            </div>

            {/* ── 中：产物核对 ── */}
            <div className="min-h-0 border-r border-border overflow-y-auto p-4 space-y-2" data-acceptance-col-artifacts data-testid="acceptance-col-artifacts">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <FileText className="size-3.5" /> 产物核对
                <span className="ml-auto font-normal">
                  {awaitingPhase ? `批次 slug: ${awaitingPhase.slug}` : ""} · {phaseArtifacts.length} 个 · 点击看全文
                </span>
              </div>
              {phaseArtifacts.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-[11px] text-muted-foreground space-y-1" data-acceptance-artifacts-empty>
                  <p>本 Phase 的批次目录暂无登记产物。</p>
                  <p className="text-[10px]">round 终态 collect 回收执行侧改动并推 task_artifacts_update；登记进产物索引后即时出现（collect 自动登记为 v4.1 接缝）。</p>
                </div>
              ) : (
                <ul className="space-y-1.5" data-acceptance-artifact-rows data-testid="acceptance-artifact-rows">
                  {phaseArtifacts.map((a) => (
                    <li key={a.path}>
                      <button
                        className="w-full text-left rounded-md border border-border px-2.5 py-1.5 hover:border-primary/40 transition-colors"
                        onClick={() => setViewing(a)}
                        data-acceptance-artifact-row={a.path} data-testid={`acceptance-artifact-row-${a.path}`}
                      >
                        <div className="flex items-center gap-2">
                          <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate">{a.title || a.path}</span>
                          {a.external && <span className="text-[10px] px-1 rounded bg-muted shrink-0">外部</span>}
                          <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{a.updated_at.slice(0, 16).replace("T", " ")}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate mt-0.5 font-mono">{a.path} · by {a.by}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── 右：动作区 ── */}
            <div className="min-h-0 overflow-y-auto p-4 space-y-3" data-acceptance-col-actions data-testid="acceptance-col-actions">
              <div className="text-xs font-semibold text-muted-foreground">动作区</div>

              {awaitingPhase ? (
                <>
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
                    <div className="rounded-md border border-amber-400/40 bg-amber-500/5 p-2.5 space-y-2" data-reject-panel>
                      <label className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
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
                        <div className="text-[11px] font-medium text-amber-700 dark:text-amber-400">下一轮路由</div>
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
                      <span className={autoOn ? "text-emerald-600" : "text-amber-600"}>{autoOn ? "开" : "关（停在你的 gate）"}</span>
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
        entry={viewing}
        onOpenChange={(o) => { if (!o) setViewing(null) }}
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
    <div className="rounded-md border border-purple-400/40 bg-purple-500/5 p-2.5 space-y-2" data-impact-list>
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
