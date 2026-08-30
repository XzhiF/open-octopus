// packages/web-app/components/tasks/execution-summary.tsx
//
// 任务看板弹窗的执行信息主体 (2026-08-29 空白弹窗优化)。ready/running/done/
// failed/aborted 五种弹窗模式此前各只有两三行占位（90vh 大弹窗几乎全空）；
// 这里按三个信息区把真实数据填满：
//   TaskOverviewCard — spec 概要（goal / ac / skills / projects / 绑定工作流可看全文）
//   ChildrenRunList  — 每条子 schedule 的最新运行：触发时间/耗时/错误摘要/
//                      按需展开 agent 输出，以及 → workspace 执行详情的深链
//   ArtifactsCard    — task home artifacts.json（listArtifacts + ArtifactViewerDialog）
//
// 数据来源：GET /api/tasks/:id（children + execution_ref 摘要，运行中 5s 轮询 +
// task_status SSE 即时刷新）；agent_output 走 GET /api/scheduler/jobs/:sid/
// executions/:eid（按需，避免详情响应过大）。
// 深链目标：/workspaces/{ws}?tab=detail&execId={exec}（workspace 页已有的
// 自动打开执行详情面板逻辑）。

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Boxes, Bot, CheckCircle2, ChevronDown, ChevronRight, Clock, ExternalLink,
  FileText, ListChecks, Target, Workflow,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { mergeLedgerParts } from "@octopus/shared"
import { getTask, listArtifacts, type TaskChild, type TaskDetail } from "@/lib/tasks-api"
import { getExecution } from "@/lib/scheduler-api"
import { fetchLLMCalls } from "@/lib/observability-api"
import type { LLMCallAggregates } from "@/lib/types"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatDuration, formatTokenCount, formatCost, formatPercent } from "@/lib/format"
import { TASK_STATUS_EVENT } from "@octopus/shared"
import type { ArtifactIndexEntry, Task } from "@octopus/shared"
import { ArtifactViewerDialog } from "./authoring/artifact-viewer-dialog"
import { WorkflowViewerDialog } from "./authoring/workflow-viewer-dialog"

export const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "待触发", queued: "已排队", claimed: "领取中", running: "执行中",
  completed: "成功", success: "成功", done: "已完成",
  failed: "失败", aborted: "已中止", skipped: "已跳过", triggered: "已触发",
  pending: "等待中",
}

const RUN_DOT: Record<string, string> = {
  queued: "bg-blue-500", claimed: "bg-amber-500", running: "bg-blue-500 animate-pulse",
  triggered: "bg-blue-500", completed: "bg-emerald-500", success: "bg-emerald-500",
  done: "bg-emerald-500", failed: "bg-red-500", aborted: "bg-zinc-500",
  skipped: "bg-zinc-500", pending: "bg-muted-foreground",
}

const ROLE_LABEL: Record<string, string> = {
  primary: "主执行", coordinator: "协调器", subunit: "子单元", auxiliary: "辅助",
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
  const ac = spec?.ac ?? []
  return (
    <SectionCard icon={<Target className="size-4" />} title="任务概要">
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
      {(task.skills.length > 0 || task.project_ids.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {task.project_ids.map(p => <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>)}
          {task.skills.map(s => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}
        </div>
      )}
      <div className="pt-1 space-y-1.5 border-t border-border/40">
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

// ── 子 schedule 运行记录 ────────────────────────────────────────────

/** execution_ref 的 workspace/execution 优先（每次运行的精确目标），回退到
 *  schedule 行上的 workspace_id（无执行 id 时只到 workspace 页）。 */
function deepLinkTarget(child: TaskChild): { url: string; exact: boolean } | null {
  const ws = child.execution_ref?.workspace_id ?? child.workspace_id
  if (!ws) return null
  const exec = child.execution_ref?.execution_id ?? null
  return exec
    ? { url: `/workspaces/${ws}?tab=detail&execId=${exec}`, exact: true }
    : { url: `/workspaces/${ws}`, exact: false }
}

function ChildRunRow({ child, now, agg }: { child: TaskChild; now: number; agg: LLMCallAggregates | null }) {
  const router = useRouter()
  const ref = child.execution_ref ?? null
  const [expanded, setExpanded] = useState(false)
  const [output, setOutput] = useState<{ state: "idle" | "loading" | "done" | "error"; text: string }>({ state: "idle", text: "" })

  const isRunning = child.status === "running" || child.status === "claimed" || child.status === "queued"
  const link = deepLinkTarget(child)

  const loadOutput = useCallback(async () => {
    if (!ref) return
    if (output.state === "done" || output.state === "loading") return
    setOutput({ state: "loading", text: "" })
    try {
      const exec = await getExecution(child.schedule_id, ref.id)
      const parts: string[] = []
      if (exec.model_used) parts.push(`模型: ${exec.model_used}`)
      if (exec.token_usage) parts.push(`tokens: ↑${exec.token_usage.inputTokens} ↓${exec.token_usage.outputTokens}`) // C1 规范字段名（基线改名残留顺手修）
      if (exec.agent_output) parts.push("", exec.agent_output)
      setOutput({ state: "done", text: parts.join("\n") || "（该次运行没有记录输出）" })
    } catch (err: unknown) {
      setOutput({ state: "error", text: err instanceof Error ? err.message : "加载失败" })
    }
  }, [ref, output.state, child.schedule_id])

  // 耗时：终态用 duration_ms；运行中用 now - triggered_at 现算（now 由上层 1s tick 驱动）
  let durationText: string | null = null
  if (ref) {
    if (ref.duration_ms != null) durationText = formatDuration(ref.duration_ms)
    else if (ref.completed_at) durationText = formatDuration(new Date(ref.completed_at).getTime() - new Date(ref.triggered_at).getTime())
    else if (isRunning) durationText = formatDuration(Math.max(0, now - new Date(ref.triggered_at).getTime()))
  }

  return (
    <div className="rounded-md border border-border bg-card p-2.5 space-y-1.5" data-run-child={child.schedule_id}>
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full shrink-0 ${RUN_DOT[child.status] ?? "bg-muted-foreground"}`} />
        <span className="text-sm font-medium truncate">{child.name}</span>
        {child.origin_role && ROLE_LABEL[child.origin_role] && (
          <span className="text-[10px] px-1 rounded bg-muted shrink-0">{ROLE_LABEL[child.origin_role]}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground shrink-0">{RUN_STATUS_LABEL[child.status] ?? child.status}</span>
      </div>

      {ref ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><Clock className="size-3 inline mr-1" />{fmtTime(ref.triggered_at)}</span>
          {durationText && <span>耗时 {durationText}</span>}
          {child.scheduled_at && <span>计划 {fmtTime(child.scheduled_at)}</span>}
          {agg && agg.totalCalls > 0 && (
            <span className="tabular-nums" title="该次运行的 LLM 调用（llm_calls 于节点结束落库，中止的半截运行可能缺数据）">
              <Bot className="size-3 inline mr-1" />{agg.totalCalls} 次调用 · ↑{formatTokenCount(agg.usage.inputTokens)} ↓{formatTokenCount(agg.usage.outputTokens)} · {formatCost(agg.totals.cost.usd, agg.totals.cost.complete)}
            </span>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">尚未开始运行{child.scheduled_at ? ` · 计划 ${fmtTime(child.scheduled_at)}` : ""}</div>
      )}

      {ref?.error_summary && (
        <p className="text-xs text-red-500 break-words whitespace-pre-wrap">{ref.error_summary}</p>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        {ref && (
          <Button
            variant="ghost" size="sm" className="h-6 px-2 text-xs"
            onClick={() => {
              const next = !expanded
              setExpanded(next)
              if (next) void loadOutput()
            }}
          >
            {expanded ? <ChevronDown className="size-3 mr-1" /> : <ChevronRight className="size-3 mr-1" />}
            {ref.status === "running" ? "实时输出" : "运行输出"}
          </Button>
        )}
        {link && (
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-xs ml-auto"
            title={link.exact ? "跳转到该次执行的流程图（实时）" : "跳转到任务工作区"}
            onClick={() => router.push(link.url)}
            data-run-deeplink={link.exact ? "execution" : "workspace"}
          >
            <ExternalLink className="size-3 mr-1" />
            {link.exact ? "查看执行详情" : "查看工作区"}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="rounded bg-muted/60 p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
          {output.state === "loading" && <span className="inline-flex items-center gap-1.5"><Spinner className="size-3" /> 加载中…</span>}
          {output.state === "done" && output.text}
          {output.state === "error" && <span className="text-red-500">{output.text}</span>}
          {output.state === "idle" && "…"}
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

/** ChildrenRunList —— 子 schedule 运行记录列表。
 *  AI 用量数据（aggMap/isLive）由 TaskRunDetailView 顶层统一拉取后注入：
 *  同一份请求喂给行内「N 次调用」与顶部任务卡，避免重复打接口。
 *  不传时（独立使用）行内退化为不显示用量，功能不受影响。 */
export function ChildrenRunList({
  children,
  aggMap,
}: {
  children?: TaskChild[]
  aggMap?: Record<string, LLMCallAggregates>
}) {
  const kids = children ?? []
  const anyRunning = kids.some(c => c.status === "running" || c.status === "claimed")
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
      right={<span className="text-xs text-muted-foreground">{kids.length} 条</span>}
    >
      {kids.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">任务尚未派发执行 —— 入队并触发后，这里会出现运行记录与实时进度入口。</p>
      ) : (
        <div className="space-y-2">
          {kids.map(c => (
            <ChildRunRow
              key={c.schedule_id}
              child={c}
              now={now}
              agg={c.execution_ref?.execution_id ? aggMap?.[c.execution_ref.execution_id] ?? null : null}
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
    const unsub = subscribeSSE(`${getServerUrl()}/api/tasks/events`, "task_artifacts_update", () => refetch())
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

/** 五态弹窗共用的信息主体：拉 TaskDetail（children + execution_ref），运行中
 *  5s 轮询 + task_status SSE 即时刷新；done/failed/aborted 各附产物区。 */
export function TaskRunDetailView({ task }: { task: Task }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const isLive = task.status === "ready" || task.status === "running"

  const refetch = useCallback(() => {
    getTask(task.id).then(setDetail).catch(() => { /* keep last snapshot */ })
  }, [task.id])

  useEffect(() => {
    refetch()
  }, [refetch])

  // 轮询兜底（ready/running：children 状态、运行时长变化）；终态不再轮询。
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

  const children = detail?.children ?? []
  const execIds = children.flatMap(c => c.execution_ref?.execution_id ? [c.execution_ref.execution_id] : [])
  const { aggMap, loaded } = useRunsAggregates(execIds, isLive)
  const totalAgg = useMemo(() => mergeAggregates(Object.values(aggMap)), [aggMap])

  return (
    <div className="h-full overflow-y-auto p-5" data-task-run-detail>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start max-w-[1400px] mx-auto">
        <div className="space-y-4 min-w-0">
          <TaskOverviewCard task={task} />
          <TaskAiUsageCard agg={totalAgg} loading={execIds.length > 0 && !loaded} runCount={execIds.length} />
        </div>
        <div className="space-y-4 min-w-0">
          <ChildrenRunList children={detail?.children} aggMap={aggMap} />
          <ArtifactsCard taskId={task.id} />
        </div>
      </div>
      {task.status === "done" && (
        <div className="max-w-[1400px] mx-auto mt-4 flex items-center gap-2 text-sm text-emerald-600">
          <CheckCircle2 className="size-4" /> 任务已完成{task.completed_at ? ` · ${fmtTime(task.completed_at)}` : ""}
        </div>
      )}
    </div>
  )
}
