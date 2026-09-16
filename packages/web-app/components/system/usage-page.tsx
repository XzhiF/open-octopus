"use client"

// usage-admin-3 票02 —— /system/usage 页骨架：明细列表 + 筛选 + 分页（聚合 tab 归 03、
// trace 展开归 04）。所有数字过 lib/format.ts（ADR-0017，无裸 toFixed）。

import { Fragment, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { LLM_CALL_SOURCE, costSummary } from "@octopus/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCost, formatDuration, formatPercent, formatTokenCount } from "@/lib/format"
import { useOrgs } from "@/hooks/useOrgs"
import { UsageTraceTree } from "@/components/system/usage-trace-tree"
import {
  fetchUsageLlmCalls, fetchUsageAggregate, fetchUsageTrace, PAGE_SIZE,
  type UsageAggregateDim, type UsageAggregateResponse, type UsageAggregateRow,
  type UsageFilters, type UsageLlmCall, type UsageLlmCallsPage,
} from "@/lib/usage-api"

const DEFAULT_FILTERS: UsageFilters = { source: "", model: "", session: "", org: "", workspace: "", window: "" }

const selectCls = "h-8 px-2 text-sm rounded-md border border-input bg-background hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"

/** 票04 展开态：锚点行 id + 该 trace 全组调用（缓存于页面层，收起再展开不重查）。 */
export interface UsageTraceState {
  anchorId: string
  traceId: string
  calls: UsageLlmCall[]
  loading: boolean
  error: string | null
}

export function UsageDetailTable({ rows, emptyText = "暂无记录", trace = null, onToggle }: {
  rows: UsageLlmCall[]
  emptyText?: string
  trace?: UsageTraceState | null
  onToggle?: (r: UsageLlmCall) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {["时间", "source", "model", "归因", "in", "out", "缓存读", "缓存写", "ttft", "耗时", "费用", "操作"].map((h) => (
            <TableHead key={h}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={12} className="h-24 text-center text-muted-foreground">{emptyText}</TableCell>
          </TableRow>
        ) : (
          rows.map((r) => {
            const isAnchor = trace?.anchorId === r.id
            const sameTrace = !!r.traceId && trace?.traceId === r.traceId
            return (
              <Fragment key={r.id}>
                <TableRow className={sameTrace && !isAnchor ? "bg-accent/50" : undefined} data-same-round={sameTrace && !isAnchor ? "true" : undefined}>
                  {/* fmt-ok: 明细时间戳全量值走 toLocaleString（format.ts 收口原则的既有分层，非私有格式化器） */}
                  <TableCell className="whitespace-nowrap">{new Date(r.timestamp).toLocaleString("zh-CN")}</TableCell>
                  <TableCell><Badge variant="outline">{r.source ?? "—"}</Badge></TableCell>
                  <TableCell className="max-w-40 truncate" title={r.model ?? undefined}>{r.model ?? "—"}</TableCell>
                  <TableCell className="max-w-40 truncate" title={r.sessionId ?? r.executionId ?? r.nodeExecutionId ?? undefined}>
                    {r.sessionId ?? r.executionId ?? r.nodeExecutionId ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">{formatTokenCount(r.inputTokens)}</TableCell>
                  <TableCell className="text-right">{formatTokenCount(r.outputTokens)}</TableCell>
                  <TableCell className="text-right">{formatTokenCount(r.cacheReadTokens)}</TableCell>
                  <TableCell className="text-right">{formatTokenCount(r.cacheCreationTokens)}</TableCell>
                  <TableCell className="text-right">{formatDuration(r.ttftMs)}</TableCell>
                  <TableCell className="text-right">{formatDuration(r.durationMs)}</TableCell>
                  <TableCell className="text-right">{formatCost(r.costUsd)}</TableCell>
                  <TableCell>
                    {!r.traceId ? (
                      <span className="text-xs text-muted-foreground">无追踪链</span>
                    ) : (
                      <Button size="sm" variant="ghost" aria-label={isAnchor ? "收起调用树" : "展开调用树"} onClick={() => onToggle?.(r)}>
                        {isAnchor ? "收起" : "展开"}
                      </Button>
                    )}
                    {sameTrace && !isAnchor && <Badge variant="secondary" className="ml-1">同轮</Badge>}
                  </TableCell>
                </TableRow>
                {isAnchor && trace && (
                  <TableRow>
                    <TableCell colSpan={12} className="bg-muted/30 p-0">
                      <UsageTraceTree calls={trace.calls} loading={trace.loading} error={trace.error} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}

const AGG_DIMS: Array<{ value: UsageAggregateDim; label: string }> = [
  { value: "day", label: "按日" },
  { value: "source", label: "按来源" },
  { value: "model", label: "按模型" },
  { value: "clone", label: "按分身" },
]

/**
 * 票03：聚合行表。占比条 = 该行 cost 对全体 cost 和（costSummary 账本口径）的占比，
 * CSS 宽度无图表库；NULL cost → 0% + "—"（三态不焊 0）。others 归并行折叠态展示。
 */
export function UsageAggregateTable({ rows, emptyText = "暂无数据" }: { rows: UsageAggregateRow[]; emptyText?: string }) {
  const totalCost = costSummary(rows.map((r) => r.costUsd)).usd // 分母走具名口径，不手搓
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {["组", "calls", "in", "out", "缓存读", "缓存写", "total", "命中率", "费用", "占比"].map((h) => (
            <TableHead key={h}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">{emptyText}</TableCell>
          </TableRow>
        ) : (
          rows.map((r) => {
            // 占比条是 CSS 宽度语义，数值仍过 formatPercent 单源（ADR-0017）
            const share = r.costUsd != null && totalCost ? formatPercent(r.costUsd / totalCost, 1) : "0%"
            return (
              <TableRow key={r.key} className={r.key === "others" ? "opacity-60" : undefined}>
                <TableCell className="max-w-52 truncate" title={r.keyLabel}>{r.keyLabel}</TableCell>
                <TableCell className="text-right">{r.calls}</TableCell>
                <TableCell className="text-right">{formatTokenCount(r.inputTokens)}</TableCell>
                <TableCell className="text-right">{formatTokenCount(r.outputTokens)}</TableCell>
                <TableCell className="text-right">{formatTokenCount(r.cacheReadTokens)}</TableCell>
                <TableCell className="text-right">{formatTokenCount(r.cacheCreationTokens)}</TableCell>
                <TableCell className="text-right">{formatTokenCount(r.totalTokens)}</TableCell>
                <TableCell className="text-right">{formatPercent(r.cacheHitRate)}</TableCell>
                <TableCell className="text-right">{formatCost(r.costUsd, r.costComplete)}</TableCell>
                <TableCell className="w-32">
                  <div className="h-2 rounded bg-pop-ink/10">
                    <div data-testid="agg-share" className="h-2 rounded bg-pop-yellow" style={{ width: share }} />
                  </div>
                </TableCell>
              </TableRow>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}

export function UsagePage() {
  const [tab, setTab] = useState<"detail" | "aggregate">("detail")
  const [dim, setDim] = useState<UsageAggregateDim>("day")
  const [filters, setFilters] = useState<UsageFilters>(DEFAULT_FILTERS)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UsageLlmCallsPage | null>(null)
  const [agg, setAgg] = useState<UsageAggregateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { orgs } = useOrgs()
  // 票04：行展开 trace 树（同 trace 缓存一次，收起再开不重查）
  const [trace, setTrace] = useState<UsageTraceState | null>(null)
  const traceCache = useRef(new Map<string, UsageLlmCall[]>())

  useEffect(() => {
    if (tab !== "detail") return
    let cancelled = false
    setLoading(true)
    fetchUsageLlmCalls(filters, page)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e: unknown) => {
        if (cancelled) return
        console.error("[usage-page] llm-calls fetch failed:", e)
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, filters, page])

  // 票03：聚合面只消费 org/时间窗（API 不支持 source/model/session 筛选）
  useEffect(() => {
    if (tab !== "aggregate") return
    let cancelled = false
    setLoading(true)
    const sub = { org: filters.org, window: filters.window, workspace: filters.workspace }
    fetchUsageAggregate(dim, sub)
      .then((d) => { if (!cancelled) { setAgg(d); setError(null) } })
      .catch((e: unknown) => {
        if (cancelled) return
        console.error("[usage-page] aggregate fetch failed:", e)
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, dim, filters.org, filters.window, filters.workspace])

  const set = (over: Partial<UsageFilters>) => { setFilters((f) => ({ ...f, ...over })); setPage(1) }

  // 票04：展开 = 拉该 trace 全组（一次），收起再展开走缓存不重查；旧行无 trace 不接线（占位在表内）
  const toggleTrace = (r: UsageLlmCall) => {
    if (trace?.anchorId === r.id) { setTrace(null); return }
    if (!r.traceId) return
    const cached = traceCache.current.get(r.traceId)
    if (cached) { setTrace({ anchorId: r.id, traceId: r.traceId, calls: cached, loading: false, error: null }); return }
    setTrace({ anchorId: r.id, traceId: r.traceId, calls: [], loading: true, error: null })
    fetchUsageTrace(r.traceId)
      .then((calls) => {
        traceCache.current.set(r.traceId!, calls)
        setTrace((prev) => prev?.anchorId === r.id ? { anchorId: r.id, traceId: r.traceId!, calls, loading: false, error: null } : prev)
      })
      .catch((e: unknown) => {
        console.error("[usage-page] trace fetch failed:", e)
        setTrace((prev) => prev?.anchorId === r.id ? { ...prev, loading: false, error: "调用树加载失败" } : prev)
      })
  }
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))

  return (
    <div className="flex flex-col h-full min-h-0 gap-3 p-4 overflow-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-black text-pop-ink">Token 使用</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* tab 切换（KD4 一屏零层级；Radix tabs 在 jsdom 走查外零依赖更省） */}
          <div className="flex rounded-md border border-input overflow-hidden" role="tablist" aria-label="视图切换">
            {([["detail", "明细"], ["aggregate", "聚合"]] as const).map(([v, label]) => (
              <button
                key={v}
                role="tab"
                aria-selected={tab === v}
                className={tab === v ? "px-3 h-8 text-sm font-black bg-pop-yellow text-pop-ink" : "px-3 h-8 text-sm font-bold hover:bg-accent"}
                onClick={() => setTab(v)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "aggregate" ? (
            <select className={selectCls} aria-label="聚合维度" value={dim} onChange={(e) => setDim(e.target.value as UsageAggregateDim)}>
              {AGG_DIMS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          ) : (
            <>
              <select className={selectCls} aria-label="来源筛选" value={filters.source} onChange={(e) => set({ source: e.target.value })}>
                <option value="">全部来源</option>
                {Object.values(LLM_CALL_SOURCE).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input className={selectCls} aria-label="模型筛选" placeholder="model" value={filters.model} onChange={(e) => set({ model: e.target.value })} />
              <input className={selectCls} aria-label="会话筛选" placeholder="session id" value={filters.session} onChange={(e) => set({ session: e.target.value })} />
            </>
          )}
          {/* US1 审查修复：工作区筛选位（server /llm-calls+/aggregate 均消费 workspace_id） */}
          <input className={selectCls} aria-label="工作区筛选" placeholder="workspace id" value={filters.workspace ?? ""} onChange={(e) => set({ workspace: e.target.value })} />
          <select className={selectCls} aria-label="组织筛选" value={filters.org} onChange={(e) => set({ org: e.target.value })}>
            <option value="">全部组织</option>
            {orgs.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
          <select className={selectCls} aria-label="时间窗" value={filters.window} onChange={(e) => set({ window: e.target.value as UsageFilters["window"] })}>
            <option value="">全部时间</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="90d">近 90 天</option>
          </select>
        </div>
      </div>

      {error && <div className="text-sm text-destructive">加载失败：{error}</div>}

      <div className="flex-1 min-h-0 rounded-lg border-2 border-pop-bd bg-pop-paper overflow-auto">
        {loading && !(tab === "detail" ? data : agg) ? (
          <div className="p-3 space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : tab === "aggregate" ? (
          <UsageAggregateTable rows={agg?.rows ?? []} emptyText={loading ? "加载中…" : "暂无数据"} />
        ) : (
          <UsageDetailTable rows={data?.calls ?? []} emptyText={loading ? "加载中…" : "暂无记录"} trace={trace} onToggle={toggleTrace} />
        )}
      </div>

      {tab === "detail" && (
        <div className="flex items-center gap-2 text-sm">
          <Button variant="outline" size="sm" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>第 {page} / {totalPages} 页 · 共 {data?.total ?? 0} 条</span>
          <Button variant="outline" size="sm" aria-label="下一页" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
