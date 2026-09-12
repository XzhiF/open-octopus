// packages/web-app/components/tasks/execution-summary.tsx
//
// 任务看板弹窗的执行信息主体 (2026-08-29 空白弹窗优化)。ready/running/done/
// failed/aborted 五种弹窗模式此前各只有两三行占位（90vh 大弹窗几乎全空）；
// 这里按三个信息区把真实数据填满：
//   TaskOverviewCard   — spec 概要（goal / ac / skills / projects / 绑定工作流可看全文）
//   ExecutionsRunList  — 任务自己的每一条运行（票03: executions 行，非子 schedule）：
//                        状态/开始/耗时 + → workspace 执行详情的深链
//   ArtifactsCard      — task home artifacts.json（listArtifacts + ArtifactViewerDialog）
//
// 数据来源：GET /api/tasks/:id（executions[] = 该任务全部根执行，新→旧；derived =
// v4 phase 视图。运行中 5s 轮询 + task_status SSE 即时刷新）。
// 深链目标：/workspaces/{ws}?tab=detail&execId={execution.id}（workspace 页已有的
// 自动打开执行详情面板逻辑）。

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Boxes, Bot, CheckCircle2, Clock, ExternalLink,
  FileText, ListChecks, Target, Workflow,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { mergeLedgerParts } from "@octopus/shared"
import { getTask, listArtifacts, type TaskDetail, type TaskExecutionBadge } from "@/lib/tasks-api"
import { fetchLLMCalls } from "@/lib/observability-api"
import type { LLMCallAggregates } from "@/lib/types"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatDuration, formatTokenCount, formatCost, formatPercent } from "@/lib/format"
import { TASK_STATUS_EVENT, TASK_EXECUTION_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, PHASE_STATUS_UPDATE_EVENT } from "@octopus/shared"
import type { ArtifactIndexEntry, Task } from "@octopus/shared"
import { ArtifactViewerDialog } from "./authoring/artifact-viewer-dialog"
import { WorkflowViewerDialog } from "./authoring/workflow-viewer-dialog"
import { PhaseTimeline } from "./phase-timeline"
import { DraftBatches } from "./authoring/draft-batches"
import { useBatchTree } from "./authoring/use-batch-tree"

// executions-row statuses (票03: a task's runs ARE executions rows — the schedule
// statuses these keys used to carry are the job pump's own run-state now).
// 'pending' = armed and waiting behind the shared concurrency cap = 已排队.
export const RUN_STATUS_LABEL: Record<string, string> = {
  pending: "已排队", running: "执行中", paused: "已暂停",
  pending_approval: "待审批", pending_resume: "待续跑",
  completed: "成功", completed_with_failures: "完成(有失败)",
  cancelled: "已取消", rejected: "已驳回",
  failed: "失败", aborted: "已中止", skipped: "已跳过",
  // 旧 schedule 词表（v3 历史行为只读，不再有新写入）
  draft: "待触发", queued: "已排队", claimed: "领取中",
  success: "成功", done: "已完成", triggered: "已触发",
}

const RUN_DOT: Record<string, string> = {
  pending: "bg-pop-amber", running: "bg-pop-cyan animate-pulse",
  paused: "bg-pop-amber", pending_approval: "bg-pop-amber", pending_resume: "bg-pop-amber",
  completed: "bg-pop-green", completed_with_failures: "bg-pop-amber",
  success: "bg-pop-green", done: "bg-pop-green",
  failed: "bg-pop-red", cancelled: "bg-pop-dim", rejected: "bg-pop-dim",
  aborted: "bg-pop-dim", skipped: "bg-pop-dim",
  // 旧 schedule 词表
  queued: "bg-pop-cyan", claimed: "bg-pop-amber", triggered: "bg-pop-cyan",
}

/** 红行词表 (票05 契约 §新事实-2)：error_summary 只在这些状态露出。绿行即便带着
 *  遗留键也绝不显示 —— 读侧按状态门控，不按字段有没有值门控。 */
export const RUN_ERROR_STATUSES = new Set(["failed", "aborted", "completed_with_failures"])

/** 一行运行的失败原因（无则 null）；所有 surfaces（看板 tooltip / 运行记录 /
 *  弹窗事件流）共用的唯一判据。 */
export function runErrorOf(exec: Pick<TaskExecutionBadge, "status" | "error_summary">): string | null {
  return RUN_ERROR_STATUSES.has(exec.status) ? exec.error_summary : null
}

// ── 通用小区块 ──────────────────────────────────────────────────────

function SectionCard({ icon, title, right, children, tone }: {
  icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode; tone?: string
}) {
  return (
    <section className={`rounded-lg border p-4 space-y-3 ${tone ?? "border-border"}`}>
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </header>
      {children}
    </section>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right min-w-0 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  )
}

function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("zh-CN") : "—"
}

// ── spec 概要 ───────────────────────────────────────────────────────

export function TaskOverviewCard({ task }: { task: Task }) {
  const spec = task.task_spec
  const [wfOpen, setWfOpen] = useState(false)
  const isV4 = spec?.format === "v4"
  const phases = spec?.phases ?? []
  const ac = spec?.ac ?? []
  return (
    <SectionCard icon={<Target className="size-4" />} title="任务概要">
      {isV4 ? (
        // v4: goal/ac 降级为摘要；概览主体是 phase 计划（每 phase 一行）。
        <div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <ListChecks className="size-3.5" /> Phase 计划 ({phases.length})
          </div>
          {phases.length > 0 ? (
            <ol className="list-decimal list-inside text-sm space-y-0.5 max-h-40 overflow-y-auto">
              {phases.map((p) => (
                <li key={p.index} className="break-words leading-snug">
                  Phase {p.index} · {p.name}
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">{p.slug}</span>
                </li>
              ))}
            </ol>
          ) : <p className="text-xs text-muted-foreground">（尚无 phase）</p>}
          {spec?.goal && (
            <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-4">{spec.goal}</p>
          )}
        </div>
      ) : (
        <>
          <div>
            <div className="text-xs text-muted-foreground mb-1">目标</div>
            <p className="text-sm whitespace-pre-wrap break-words line-clamp-6">{spec?.goal || "（尚未填写）"}</p>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <ListChecks className="size-3.5" /> 验收标准 ({ac.length})
            </div>
            {ac.length > 0 ? (
              <ol className="list-decimal list-inside text-sm space-y-0.5 max-h-40 overflow-y-auto">
                {ac.map((a, i) => <li key={i} className="break-words leading-snug">{a}</li>)}
              </ol>
            ) : <p className="text-xs text-muted-foreground">（无）</p>}
          </div>
        </>
      )}
      {(task.skills.length > 0 || task.project_ids.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {task.project_ids.map(p => <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>)}
          {task.skills.map(s => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}
        </div>
      )}
      <div className="pt-1 space-y-1.5 border-t border-border/40">
        {isV4 ? (
          // v4 绑定按 Phase 存（phases[].workflowRef）；任务级 workflow_ref 恒
          // null，旧代码显成「绑定工作流 —」= 看着没绑却进了待执行。逐 Phase 列真值。
          <div className="space-y-1" data-v4-workflow-refs>
            <span className="text-muted-foreground text-sm">绑定工作流（按 Phase）</span>
            {phases.map((p) => (
              <div key={p.index} className="flex items-baseline justify-between gap-3 text-xs" data-v4-workflow-ref={p.index}>
                <span className="text-muted-foreground shrink-0">Phase {p.index} · {p.name}</span>
                <code className="text-xs truncate max-w-[240px]">{p.workflowRef || "未绑定"}</code>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted-foreground shrink-0">绑定工作流</span>
            <span className="flex items-center gap-2 min-w-0">
              <code className="text-xs truncate max-w-[240px]">{task.workflow_ref ?? "—"}</code>
              {task.workflow_ref && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setWfOpen(true)}>
                  查看
                </Button>
              )}
            </span>
          </div>
        )}
        <InfoRow label="创建" value={fmtTime(task.created_at)} />
        {task.completed_at && <InfoRow label="完成" value={fmtTime(task.completed_at)} />}
      </div>
      <WorkflowViewerDialog
        taskId={task.id}
        workflowRef={task.workflow_ref ?? null}
        open={wfOpen}
        onOpenChange={setWfOpen}
      />
    </SectionCard>
  )
}

// ── 任务运行记录 (票03: 一次运行 = executions 一行) ─────────────────

/** 深链目标：徽章自带 (workspace_id, id) —— 旧契约里 execution_ref 的那一跳没了。 */
function deepLinkTarget(exec: TaskExecutionBadge): string | null {
  return exec.workspace_id
    ? `/workspaces/${exec.workspace_id}?tab=detail&execId=${exec.id}`
    : null
}

/** 行标题。v4 的 phase/round 直接落在执行行上，「第几轮」是最贴近轮次语义的标签；
 *  其次票05 起徽章自带的 `name`（simple 运行名 / composite 子单元臂名 —— 派发时
 *  dispatchChildRun 把 subunit.name 写进了行）；再退工作流名。 */
function execLabel(exec: TaskExecutionBadge): string {
  if (exec.phase_index != null) {
    return exec.round_index != null
      ? `Phase ${exec.phase_index} · Round ${exec.round_index}`
      : `Phase ${exec.phase_index}`
  }
  return exec.name || exec.workflow_ref || `执行 ${exec.id.slice(0, 8)}`
}

/** 还没跑完的状态 —— 驱动「实时耗时」的每秒一跳。pending = 武装后在并发闸后排队。 */
const LIVE_STATUSES = new Set(["pending", "running", "paused", "pending_approval", "pending_resume"])

/** 一次运行的记录行：状态点 + 标题 + 起止/耗时 + （红行）一行失败原因 +
 *  （composite）票05 载入的子单元臂。臂只认 `exec.children`：undefined = 本表面
 *  没加载 fan-out（看板 badge 即如此），什么都不渲染 —— 「没加载」不是「没有」，
 *  所以这里永远不出「无子单元」空态；[]= 加载了且确实没有，同样不渲染。 */
function ExecRunRow({ exec, now, agg }: { exec: TaskExecutionBadge; now: number; agg: LLMCallAggregates | null }) {
  const router = useRouter()
  const link = deepLinkTarget(exec)
  const startedMs = exec.started_at ? Date.parse(exec.started_at) : Date.parse(exec.created_at)
  const error = runErrorOf(exec)
  const arms = exec.children ?? []

  // 耗时：徽章没有 duration_ms，自己算 —— 终态 completed_at-started_at；
  // 在跑 now-started_at（now 由上层 1s tick 驱动）。
  let durationText: string | null = null
  if (!Number.isNaN(startedMs)) {
    if (exec.completed_at) durationText = formatDuration(Math.max(0, Date.parse(exec.completed_at) - startedMs))
    else if (LIVE_STATUSES.has(exec.status)) durationText = formatDuration(Math.max(0, now - startedMs))
  }

  return (
    <div className="rounded-xl border-2 border-pop-bd bg-pop-paper shadow-pop-sm p-2.5 space-y-1.5" data-run-child={exec.id}>
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full shrink-0 ${RUN_DOT[exec.status] ?? "bg-muted-foreground"}`} />
        <span className="text-sm font-medium truncate">{execLabel(exec)}</span>
        <span className="ml-auto text-xs text-muted-foreground shrink-0">{RUN_STATUS_LABEL[exec.status] ?? exec.status}</span>
      </div>

      {error && (
        <div className="text-xs text-pop-red break-words" data-run-error={exec.id}>{error}</div>
      )}

      {arms.length > 0 && (
        <div className="pl-3 space-y-1 border-l border-border/60" data-run-arms={exec.id}>
          {arms.map((arm) => {
            const armError = runErrorOf(arm)
            return (
              <div key={arm.id} className="text-xs" data-run-arm={arm.id}>
                <div className="flex items-center gap-2">
                  <span className={`size-1.5 rounded-full shrink-0 ${RUN_DOT[arm.status] ?? "bg-muted-foreground"}`} />
                  <span className="truncate font-medium">{arm.name || arm.workflow_ref || `执行 ${arm.id.slice(0, 8)}`}</span>
                  <span className="ml-auto text-muted-foreground shrink-0">{RUN_STATUS_LABEL[arm.status] ?? arm.status}</span>
                </div>
                {armError && <div className="text-pop-red break-words pl-3.5" data-run-error={arm.id}>{armError}</div>}
              </div>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><Clock className="size-3 inline mr-1" />{fmtTime(exec.started_at ?? exec.created_at)}</span>
        {durationText && <span>耗时 {durationText}</span>}
        {agg && agg.totalCalls > 0 && (
          <span className="tabular-nums" title="该次运行的 LLM 调用（llm_calls 于节点结束落库，中止的半截运行可能缺数据）">
            <Bot className="size-3 inline mr-1" />{agg.totalCalls} 次调用 · ↑{formatTokenCount(agg.usage.inputTokens)} ↓{formatTokenCount(agg.usage.outputTokens)} · {formatCost(agg.totals.cost.usd, agg.totals.cost.complete)}
          </span>
        )}
      </div>

      {link && (
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-xs ml-auto"
            title="跳转到该次执行的流程图（实时）"
            onClick={() => router.push(link)}
            data-run-deeplink="execution"
          >
            <ExternalLink className="size-3 mr-1" />
            查看执行详情
          </Button>
        </div>
      )}
    </div>
  )
}

// ── AI 用量聚合（calls / tokens / 成本 / 模型分布）──────────────────
//
// 数据源：GET /api/executions/{execution_id}/llm-calls —— provider 层 LLMCallTracker
// 落库的逐调用记录（含 model、input/output/cache tokens、costUsd），此处按 run 汇总。
// execution_id 集合不变时不重复拉取；有运行中的 run 时每 5s 跟随刷新。

function useRunsAggregates(execIds: string[], isLive: boolean) {
  const key = execIds.join(",")
  const [aggMap, setAggMap] = useState<Record<string, LLMCallAggregates>>({})
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const ids = key ? key.split(",") : []
    if (ids.length === 0) { setAggMap({}); setLoaded(true); return }
    let cancelled = false
    const load = () => {
      void Promise.all(ids.map(async (id) => {
        try {
          const { aggregates } = await fetchLLMCalls(id)
          // 旧服务/无数据时 aggregates 可能为 null —— 跳过而不是塞进 map。
          if (!aggregates) return null
          return [id, aggregates] as const
        } catch { return null }
      })).then((pairs) => {
        if (cancelled) return
        setLoaded(true)
        setAggMap(prev => {
          const next: Record<string, LLMCallAggregates> = {}
          for (const p of pairs) if (p) next[p[0]] = p[1]
          // 全部失败时保留旧值，避免闪烁
          return Object.keys(next).length > 0 ? next : prev
        })
      })
    }
    load()
    if (!isLive) return () => { cancelled = true }
    const timer = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [key, isLive])
  return { aggMap, loaded }
}

function mergeAggregates(list: LLMCallAggregates[]): LLMCallAggregates | null {
  if (list.length === 0) return null
  // C3: 合并公式在 shared mergeLedgerParts 单源（旧 V4 加权 bug —— 权重 ||1
  // 分母 ||0 不一致 —— 随此删除）
  const merged = mergeLedgerParts(list.map(a => ({ usage: a.usage, cost: a.totals.cost })))
  const modelBreakdown: LLMCallAggregates["modelBreakdown"] = {}
  for (const a of list) {
    for (const [m, b] of Object.entries(a.modelBreakdown ?? {})) {
      const cur = modelBreakdown[m]
      if (!cur) { modelBreakdown[m] = { ...b }; continue }
      modelBreakdown[m] = {
        calls: cur.calls + b.calls,
        inputTokens: cur.inputTokens + b.inputTokens,
        outputTokens: cur.outputTokens + b.outputTokens,
        cacheReadTokens: (cur.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
        cacheCreationTokens: (cur.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
        costUsd: cur.costUsd === null ? b.costUsd : (b.costUsd === null ? cur.costUsd : cur.costUsd + b.costUsd),
      }
    }
  }
  return {
    totalCalls: list.reduce((a, x) => a + x.totalCalls, 0),
    toolCalls: list.reduce((a, x) => a + (x.toolCalls ?? 0), 0),
    usage: merged.usage,
    totals: merged.totals,
    modelBreakdown,
  }
}

/** 任务级 AI 消耗卡（2026-08-29 语义修正）：聚合该任务**全部工作流执行**的
 *  LLM 调用 —— simple=1 条主执行、composite=协调器+N 子单元全部求和，所以它是
 *  任务口径而非单次执行口径；单次执行的用量在下方各行内联展示。
 *  统计面备注：编写期 task-author 对话的 token 目前没有落库来源（token_usage
 *  表未建，见已中止的「token计费」任务），如实标注不臆造。 */
export function TaskAiUsageCard({ agg, loading, runCount }: {
  agg: LLMCallAggregates | null; loading: boolean; runCount: number
}) {
  if (runCount === 0) return null
  const models = agg ? Object.entries(agg.modelBreakdown).sort((a, b) => b[1].calls - a[1].calls) : []
  return (
    <SectionCard
      icon={<Bot className="size-4" />}
      title="任务 AI 消耗"
      right={<span className="text-[10px] text-muted-foreground">全部 {runCount} 次执行合计 · 不含编写期对话</span>}
    >
      {!agg || agg.totalCalls === 0 ? (
        <p className="text-xs text-muted-foreground" data-ai-usage>
          {loading
            ? "统计加载中…"
            : "暂无已落库的 LLM 调用记录（llm_calls 在节点结束时写入；半途中止的运行可能缺数据）。"}
        </p>
      ) : (
        <div className="space-y-2" data-ai-usage>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
            <span className="text-muted-foreground">调用 <b className="text-foreground tabular-nums">{agg.totalCalls}</b> 次</span>
            <span className="tabular-nums" title="input / output tokens">↑{formatTokenCount(agg.usage.inputTokens)} ↓{formatTokenCount(agg.usage.outputTokens)}</span>
            {(agg.usage.cacheReadTokens > 0 || agg.usage.cacheCreationTokens > 0) && (
              <span className="text-xs text-muted-foreground tabular-nums" title={agg.totals.cacheHitRate === null ? "缓存命中率: 无输入类 token" : `缓存命中率 ${formatPercent(agg.totals.cacheHitRate, 1)}`}>
                缓存 读{formatTokenCount(agg.usage.cacheReadTokens)}·写{formatTokenCount(agg.usage.cacheCreationTokens)}
              </span>
            )}
            <span className="font-semibold tabular-nums" title="价表估算（≈=部分未定价）">{formatCost(agg.totals.cost.usd, agg.totals.cost.complete)}</span>
          </div>
          {models.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {models.map(([m, b]) => (
                <Badge key={m} variant="outline" className="text-[10px] font-mono" title={`${b.calls} 次 · ↑${b.inputTokens} ↓${b.outputTokens} · ${formatCost(b.costUsd)}`}>
                  {m}×{b.calls}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

/** ExecutionsRunList —— 任务的运行记录（票03: GET /:id 的 executions[]，新→旧）。
 *  AI 用量数据（aggMap/isLive）由 TaskRunDetailView 顶层统一拉取后注入：
 *  同一份请求喂给行内「N 次调用」与顶部任务卡，避免重复打接口。
 *  不传时（独立使用）行内退化为不显示用量，功能不受影响。 */
export function ExecutionsRunList({
  executions,
  aggMap,
}: {
  executions?: TaskExecutionBadge[]
  aggMap?: Record<string, LLMCallAggregates>
}) {
  const runs = executions ?? []
  const anyRunning = runs.some(e => LIVE_STATUSES.has(e.status))
  // 运行中每秒一跳，驱动「实时耗时」显示（数据刷新由上层 5s 轮询负责）。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anyRunning])

  return (
    <SectionCard
      icon={<Workflow className="size-4" />}
      title="执行记录"
      right={<span className="text-xs text-muted-foreground">{runs.length} 条</span>}
    >
      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">任务尚未派发执行 —— 入队并触发后，这里会出现运行记录与实时进度入口。</p>
      ) : (
        <div className="space-y-2">
          {runs.map(e => (
            <ExecRunRow
              key={e.id}
              exec={e}
              now={now}
              agg={aggMap?.[e.id] ?? null}
            />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// ── 产物 ────────────────────────────────────────────────────────────

export function ArtifactsCard({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<ArtifactIndexEntry[] | null>(null)
  const [viewing, setViewing] = useState<ArtifactIndexEntry | null>(null)

  const refetch = useCallback(() => {
    listArtifacts(taskId).then(setEntries).catch(() => setEntries([]))
  }, [taskId])

  useEffect(() => {
    refetch()
    // 产物索引更新即刷新（task-home 写入方会 emit 到 /api/tasks/events）。
    const unsub = subscribeSSE(`${getServerUrl()}/api/tasks/events`, TASK_ARTIFACTS_UPDATE_EVENT, () => refetch())
    return unsub
  }, [refetch])

  return (
    <SectionCard
      icon={<FileText className="size-4" />}
      title="任务产物"
      right={entries ? <span className="text-xs text-muted-foreground">{entries.length} 个</span> : <Spinner className="size-3" />}
    >
      {entries === null ? (
        <p className="text-xs text-muted-foreground">加载中…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">暂无登记产物。</p>
      ) : (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto">
          {entries.map(a => (
            <li key={a.path}>
              <button
                className="w-full text-left rounded-md border border-border px-2.5 py-1.5 hover:border-primary/40 transition-colors"
                onClick={() => setViewing(a)}
              >
                <div className="flex items-center gap-2">
                  <Boxes className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm truncate">{a.title || a.path}</span>
                  {a.external && <span className="text-[10px] px-1 rounded bg-muted shrink-0">外部</span>}
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{new Date(a.updated_at).toLocaleString("zh-CN")}</span>
                </div>
                <div className="text-[11px] text-muted-foreground truncate mt-0.5 font-mono">{a.path} · by {a.by}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ArtifactViewerDialog taskId={taskId} entry={viewing} onOpenChange={o => { if (!o) setViewing(null) }} />
    </SectionCard>
  )
}

// ── 组合视图（弹窗主体）─────────────────────────────────────────────

/** 五态弹窗共用的信息主体：拉 TaskDetail（executions[] 运行历史 + derived v4 视图），
 *  运行中 5s 轮询 + task_status / task_execution / phase_status_update SSE 即时刷新；
 *  done/failed/aborted 各附产物区。票 11：顶部插 PhaseTimeline（v4 每 phase 一
 *  行；v3 legacy 单行；旧 server 无 derived 字段 → 组件内静默）。 */
export function TaskRunDetailView({ task }: { task: Task }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  // v4 的 awaiting_review / archiving 同样是「盘面还会动」的窗口（round 在跑 /
  // 归档编排中），保持轮询；纯终态才停。
  const isLive =
    task.status === "ready" || task.status === "running" ||
    task.status === "awaiting_review" || task.status === "archiving"

  const refetch = useCallback(() => {
    getTask(task.id).then(setDetail).catch(() => { /* keep last snapshot */ })
  }, [task.id])

  useEffect(() => {
    refetch()
  }, [refetch])

  // 轮询兜底（ready/running：运行行状态、运行时长变化）；终态不再轮询。
  useEffect(() => {
    if (!isLive) return
    const id = setInterval(refetch, 5000)
    return () => clearInterval(id)
  }, [isLive, refetch])

  // task_status SSE：生命周期迁移即时重拉（入队→running、done、failed…）。
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      TASK_STATUS_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { task_id?: string }
          if (payload.task_id === task.id) refetch()
        } catch { /* malformed — ignore */ }
      },
    )
    return unsub
  }, [task.id, refetch])

  // 票03 (ADR-0021) task_execution SSE：任务自己的实例状态变化（arm→pending、
  // 领取→running、终态、被闸抑制…）由内置 task-lifecycle job 发在 taskpool 上。
  // 排队中的 pending 行不再镜像成 task_status（那正是「排队看着像在执行」的旧 bug），
  // 所以运行记录的即时刷新挂在这个事件上，权威态仍是 GET /:id。
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      TASK_EXECUTION_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { task_id?: string }
          if (payload.task_id === task.id) refetch()
        } catch { /* malformed — ignore */ }
      },
    )
    return unsub
  }, [task.id, refetch])

  // 票 11/⑦: phase_status_update SSE（票 07 验收链路的派生态变化）— re-derive
  // and re-render nudge，权威态仍是 GET /:id 的 derived（K3 派生不存）。
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      PHASE_STATUS_UPDATE_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { task_id?: string }
          if (payload.task_id === task.id) refetch()
        } catch { /* malformed — ignore */ }
      },
    )
    return unsub
  }, [task.id, refetch])

  const runs = detail?.executions ?? []
  // spec/tickets 可见性补齐：draft 面板的「草稿批次」区（DraftBatches，磁盘
  // 直扫 /batch-tree）此前只挂在 AuthoringWorkspace —— 入队后弹窗里看不到
  // phase 的 spec.md/issues/，验收时无从对照。执行态以 isDraft=false 只读
  // 复用同区；刷新沿 detail.version 轮询（home 环：collect 回流会 bump）。
  const batchTree = useBatchTree(task.id, { versionKey: detail?.version })
  const execIds = runs.map(r => r.id)
  const { aggMap, loaded } = useRunsAggregates(execIds, isLive)
  const totalAgg = useMemo(() => mergeAggregates(Object.values(aggMap)), [aggMap])

  return (
    <div className="h-full overflow-y-auto p-5" data-task-run-detail>
      <div className="max-w-[1400px] mx-auto mb-4">
        <PhaseTimeline derived={detail?.derived} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start max-w-[1400px] mx-auto">
        <div className="space-y-4 min-w-0">
          <TaskOverviewCard task={task} />
          {task.task_spec?.format === "v4" && (task.task_spec.phases?.length ?? 0) > 0 && (
            <DraftBatches
              task={task}
              phases={task.task_spec.phases ?? []}
              isDraft={false}
              tree={batchTree}
              onMutated={refetch}
            />
          )}
          <TaskAiUsageCard agg={totalAgg} loading={execIds.length > 0 && !loaded} runCount={execIds.length} />
        </div>
        <div className="space-y-4 min-w-0">
          <ExecutionsRunList executions={detail?.executions} aggMap={aggMap} />
          <ArtifactsCard taskId={task.id} />
        </div>
      </div>
      {task.status === "done" && (
        <div className="max-w-[1400px] mx-auto mt-4 flex items-center gap-2 text-sm text-pop-green">
          <CheckCircle2 className="size-4" /> 任务已完成{task.completed_at ? ` · ${fmtTime(task.completed_at)}` : ""}
        </div>
      )}
    </div>
  )
}
