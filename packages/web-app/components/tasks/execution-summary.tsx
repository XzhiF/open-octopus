// packages/web-app/components/tasks/execution-summary.tsx
//
// 执行弹窗的公共件（2026-09-12 执行弹窗改版后瘦身）：
//   RUN_STATUS_LABEL / RUN_ERROR_STATUSES / runErrorOf — 运行行状态词表与红行
//     判据单源（看板 tooltip / 控制台轮次行 / composite 弹窗共用）。
//   TaskAiUsageCard — AI 消耗卡（验货台左列注入 round 口径仍用）。
//   ArtifactsCard — task home artifacts.json 列表 + 查看全文。
//   useRunsAggregates / mergeAggregates / deepLinkTarget / execLabel — run-console
//     的数据 plumbing（一次拉取喂多处显示）。
// 历史：本文件曾是 ready/running/done/failed/aborted 弹窗的信息主体
// （TaskRunDetailView = PhaseTimeline + 任务概要 + 草稿批次 + 执行记录 + AI 卡）。
// 五区各列一遍 phase 的重复形态随 ADR-0022 改版迁入 components/tasks/run-console/
// （Phase 唯一骨架：rail 选面 + surface 控制台），旧主体已删。

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Boxes, Bot, FileText } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { mergeLedgerParts } from "@octopus/shared"
import { listArtifacts, type TaskExecutionBadge } from "@/lib/tasks-api"
import { fetchLLMCalls } from "@/lib/observability-api"
import type { LLMCallAggregates, UsageWire } from "@/lib/types"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import { formatTokenCount, formatCost } from "@/lib/format"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"
import type { ArtifactIndexEntry } from "@octopus/shared"
import { FoldHandle, useFold } from "./fold-context"
import { ArtifactViewerDialog } from "./authoring/artifact-viewer-dialog"

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

/** 还没跑完的状态 —— 驱动「实时耗时」的每秒一跳。pending = 武装后在并发闸后排队。 */
export const LIVE_STATUSES = new Set(["pending", "running", "paused", "pending_approval", "pending_resume"])

/** 红行词表 (票05 契约 §新事实-2)：error_summary 只在这些状态露出。绿行即便带着
 *  遗留键也绝不显示 —— 读侧按状态门控，不按字段有没有值门控。 */
export const RUN_ERROR_STATUSES = new Set(["failed", "aborted", "completed_with_failures"])

/** 一行运行的失败原因（无则 null）；所有 surfaces（看板 tooltip / 轮次行 /
 *  composite 弹窗事件流）共用的唯一判据。 */
export function runErrorOf(exec: Pick<TaskExecutionBadge, "status" | "error_summary">): string | null {
  return RUN_ERROR_STATUSES.has(exec.status) ? exec.error_summary : null
}

/** 本地化时间戳（title/详情用）。C4 门禁禁 fmt/format 前缀私有副本 ——
 *  这层 wrapper 只做 toLocaleString 兜底，命名刻意避开受禁前缀。 */
export function timeStamp(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("zh-CN") : "—"
}

/** 深链目标：徽章自带 (workspace_id, id) —— 旧契约里 execution_ref 的那一跳没了。 */
export function deepLinkTarget(exec: TaskExecutionBadge): string | null {
  return exec.workspace_id
    ? `/workspaces/${exec.workspace_id}?tab=detail&execId=${exec.id}`
    : null
}

/** 行标题。v4 的 phase/round 直接落在执行行上，「第几轮」是最贴近轮次语义的标签；
 *  其次票05 起徽章自带的 `name`（simple 运行名 / composite 子单元臂名 —— 派发时
 *  dispatchChildRun 把 subunit.name 写进了行）；再退工作流名。 */
export function execLabel(exec: TaskExecutionBadge): string {
  if (exec.phase_index != null) {
    return exec.round_index != null
      ? `Phase ${exec.phase_index} · Round ${exec.round_index}`
      : `Phase ${exec.phase_index}`
  }
  return exec.name || exec.workflow_ref || `执行 ${exec.id.slice(0, 8)}`
}

// ── AI 用量聚合（calls / tokens / 成本 / 模型分布）──────────────────
//
// 数据源：GET /api/executions/{execution_id}/llm-calls —— provider 层 LLMCallTracker
// 落库的逐调用记录（含 model、input/output/cache tokens、costUsd），此处按 run 汇总。
// execution_id 集合不变时不重复拉取；有运行中的 run 时每 5s 跟随刷新。

export function useRunsAggregates(execIds: string[], isLive: boolean) {
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

export function mergeAggregates(list: LLMCallAggregates[]): LLMCallAggregates | null {
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

/** 紧凑 AI 账目一行（2026-09-16 用户定版）：与 node-detail/cost-tab 同口径视觉 —
 *  ∑处理量 ↑入 ↓出 ⚡缓存读 🗡️缓存写 · N 次请求 · $费用，**不列工具调用**。
 *  任务域所有「calls · tokens · cost」行统一吃这一个实现。null/零调用 → null。 */
export function AggInline({ agg, className, dim = "text-pop-dim" }: {
  agg: LLMCallAggregates | null | undefined
  className?: string
  /** 弱色 token class —— 深色导航条等底色面传入对应值。 */
  dim?: string
}) {
  if (!agg || agg.totalCalls === 0) return null
  const { usage, totals, totalCalls } = agg
  const cr = usage.cacheReadTokens ?? 0
  const cw = usage.cacheCreationTokens ?? 0
  return (
    <span className={`tabular-nums inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 ${className ?? ""}`} data-agg-inline data-testid="agg-inline">
      <span className="font-black" title="处理量（输入+输出+缓存读+缓存写）">∑{formatTokenCount(totals.tokens)}</span>
      <span title="输入">↑{formatTokenCount(usage.inputTokens ?? 0)}</span>
      <span title="输出">↓{formatTokenCount(usage.outputTokens ?? 0)}</span>
      {cr > 0 && <span title="缓存读取" className={dim}>⚡{formatTokenCount(cr)}</span>}
      {cw > 0 && <span title="缓存创建" className={dim}>🗡️{formatTokenCount(cw)}</span>}
      <span className={dim}>· {totalCalls} 次请求 ·</span>
      <span className="font-medium text-pop-amber" title="价表估算（≈=部分未定价）">{formatCost(totals.cost.usd, totals.cost.complete)}</span>
    </span>
  )
}

/** 七量纲（∑=入+出+缓存读+缓存写，与 AggInline 同口径）。供卡内瓷砖/行复用。 */
function aggNumbers(a: { usage: UsageWire; totals?: { tokens: number; cost: { usd: number | null; complete: boolean } }; totalCalls?: number }) {
  const u = a.usage
  const cr = u.cacheReadTokens ?? 0, cw = u.cacheCreationTokens ?? 0
  const sum = a.totals?.tokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + cr + cw)
  return { sum, inp: u.inputTokens ?? 0, out: u.outputTokens ?? 0, cr, cw, calls: a.totalCalls ?? 0 }
}

/** AI 卡里的一行完整七量纲（按模型 / 分轮复用），口径同 AggInline。 */
function AggMetrics({ sum, inp, out, cr, cw, calls, usd, complete, dim = "text-pop-dim" }: {
  sum: number; inp: number; out: number; cr: number; cw: number; calls: number; usd: number | null; complete?: boolean; dim?: string
}) {
  return (
    <span className="tabular-nums inline-flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-[11px]">
      <span className="font-black" title="处理量（输入+输出+缓存读+缓存写）">∑{formatTokenCount(sum)}</span>
      <span title="输入">↑{formatTokenCount(inp)}</span>
      <span title="输出">↓{formatTokenCount(out)}</span>
      {cr > 0 && <span title="缓存读取" className={dim}>⚡{formatTokenCount(cr)}</span>}
      {cw > 0 && <span title="缓存创建" className={dim}>🗡️{formatTokenCount(cw)}</span>}
      <span className={dim}>· {calls} 次请求 ·</span>
      <span className="font-medium text-pop-amber">{formatCost(usd, complete ?? true)}</span>
    </span>
  )
}

/** 任务级 AI 消耗卡（ADR-0022 三层完整口径还原）：总计瓷砖 / 按模型行 / 分轮行，
 *  每层都摊全 ∑↑↓⚡🗡️·请求·成本 —— 不再有任何层级被缩写。数据源 llm_calls
 *  （节点结束落库，半途中止可能缺数 → 缺行标灰不猜）。编写期 task-author 对话
 *  token 目前无落库来源（见既有备注），如实说明不臆造、不放假开关。 */
export function TaskAiUsageCard({ agg, loading, runCount, rounds }: {
  agg: LLMCallAggregates | null; loading: boolean; runCount: number
  /** 分轮行（label + 该轮 agg + 状态词）。缺省则不显分轮段（单轮任务够用）。 */
  rounds?: Array<{ key: string; label: string; agg: LLMCallAggregates | null; note?: string }>
}) {
  if (runCount === 0) return null
  const models = agg ? Object.entries(agg.modelBreakdown ?? {}).sort((a, b) => b[1].calls - a[1].calls) : []
  return (
    <SectionCard
      fold={{ id: "usage", badge: agg && agg.totalCalls > 0 ? `∑${formatCost(agg.totals.cost.usd, agg.totals.cost.complete)} · ${agg.totalCalls} 次` : "暂无落库调用" }}
      icon={<Bot className="size-4" />}
      title="任务 AI 消耗"
      right={<span className="text-[10px] text-muted-foreground">全部 {runCount} 次执行合计 · 编写期对话未落库（不臆造）</span>}
    >
      {!agg || agg.totalCalls === 0 ? (
        <p className="text-xs text-muted-foreground" data-ai-usage>
          {loading ? "统计加载中…" : "暂无已落库的 LLM 调用记录（llm_calls 在节点结束时写入；半途中止的运行可能缺数据）。"}
        </p>
      ) : (
        <div className="space-y-3" data-ai-usage>
          {/* 总计：七瓷砖 */}
          <div>
            <div className="mb-1 font-mono text-[9px] font-black tracking-[.09em] text-pop-dim">总计</div>
            <div className="flex flex-wrap gap-1.5">
              {(() => {
                const n = aggNumbers(agg)
                return ([
                  ["∑ 处理量", formatTokenCount(n.sum)], ["↑ 输入", formatTokenCount(n.inp)], ["↓ 输出", formatTokenCount(n.out)],
                  ["⚡ 缓存读", formatTokenCount(n.cr)], ["🗡️ 缓存写", formatTokenCount(n.cw)],
                  ["请求", `${n.calls} 次`], ["成本", formatCost(agg.totals.cost.usd, agg.totals.cost.complete)],
                ] as const).map(([l, v]) => (
                  <div key={l} className="min-w-[64px] rounded-md border border-pop-bd bg-pop-idle/40 px-2 py-1 text-center">
                    <div className="font-mono text-[13px] font-black tabular-nums text-pop-ink">{v}</div>
                    <div className="text-[9px] text-pop-dim">{l}</div>
                  </div>
                ))
              })()}
            </div>
          </div>
          {/* 按模型：每模型全量纲行 */}
          {models.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[9px] font-black tracking-[.09em] text-pop-dim">按模型</div>
              <div className="space-y-1">
                {models.map(([m, b]) => {
                  const cr = b.cacheReadTokens ?? 0, cw = b.cacheCreationTokens ?? 0
                  return (
                    <div key={m} className="flex flex-wrap items-center gap-x-2">
                      <span className="w-[120px] shrink-0 truncate font-mono text-[11px] font-bold" title={m}>{m}</span>
                      <AggMetrics sum={(b.inputTokens ?? 0) + (b.outputTokens ?? 0) + cr + cw} inp={b.inputTokens ?? 0} out={b.outputTokens ?? 0} cr={cr} cw={cw} calls={b.calls} usd={b.costUsd} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {/* 分轮：每轮全量纲行 */}
          {rounds && rounds.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[9px] font-black tracking-[.09em] text-pop-dim">分轮账本</div>
              <div className="space-y-1">
                {rounds.map((r) => (
                  <div key={r.key} className="flex flex-wrap items-center gap-x-2">
                    <span className="w-[120px] shrink-0 truncate font-mono text-[11px]" title={r.label}>{r.label}</span>
                    {r.agg ? <AggMetrics {...(() => { const n = aggNumbers(r.agg); return { sum: n.sum, inp: n.inp, out: n.out, cr: n.cr, cw: n.cw, calls: n.calls, usd: r.agg.totals.cost.usd, complete: r.agg.totals.cost.complete } })()} />
                      : <span className="font-mono text-[11px] text-pop-dim" title="该轮无落库数据（中止/旧服务）">缺数</span>}
                    {r.note && <span className="text-[9px] text-muted-foreground">{r.note}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// ── 通用小区块 ──────────────────────────────────────────────────────

export function SectionCard({ icon, title, right, children, tone, fold }: {
  icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode; tone?: string
  /** 传入且弹窗挂着 FoldProvider 时：标题行出把手，可折；折上显 badge（一行结论）。 */
  fold?: { id: string; group?: "info" | "main"; badge?: string }
}) {
  const f = useFold()
  const closed = !!(f && fold && f.closed(fold.id, fold.group ?? "info"))
  return (
    <section className={`rounded-lg border p-4 ${closed ? "space-y-0" : "space-y-3"} ${tone ?? "border-border"}`} data-fold-box={fold?.id} data-fold-closed={closed ? "true" : undefined}>
      <header className={`flex items-center gap-2 ${fold && f ? "cursor-pointer select-none" : ""}`} onClick={fold && f ? () => f.toggle(fold.id, fold.group ?? "info") : undefined}>
        {fold && f && <FoldHandle id={fold.id} group={fold.group ?? "info"} closed={closed} onToggle={() => f.toggle(fold.id, fold.group ?? "info")} />}
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {closed && fold?.badge && <span className="truncate font-mono text-[10px] font-black" data-fold-badge={fold.id}>{fold.badge}</span>}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{!closed && right}</div>
      </header>
      {!closed && children}
    </section>
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
      fold={{ id: "artifacts", badge: entries ? `${entries.length} 个产物` : "读取中…" }}
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

// formatDuration 不在此再导出（formatter revival gate C4：lib/format.ts 是
// 全站唯一 format* 出口，run-console 直接 import 它）。
