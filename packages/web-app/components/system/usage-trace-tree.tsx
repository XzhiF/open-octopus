"use client"

// usage-admin-3 票04 —— trace 展开路径树：会话/执行 → 轮 → 逐次调用。
// 小计折叠全部走 shared ledger 具名函数（addTokenUsage/totalTokens/costSummary，
// 口径单源不手搓）；数字展示过 lib/format.ts（ADR-0017）。

import { addTokenUsage, costSummary, emptyTokenUsage, totalTokens } from "@octopus/shared"
import { formatCost, formatDuration, formatTokenCount } from "@/lib/format"
import type { UsageLlmCall } from "@/lib/usage-api"

export function UsageTraceTree({ calls, loading = false, error = null }: {
  calls: UsageLlmCall[]
  loading?: boolean
  error?: string | null
}) {
  if (loading) return <div data-testid="trace-tree" className="p-2 text-sm text-muted-foreground">加载中…</div>
  if (error) return <div data-testid="trace-tree" className="p-2 text-sm text-destructive">{error}</div>
  if (calls.length === 0) return <div data-testid="trace-tree" className="p-2 text-sm text-muted-foreground">无追踪链</div>

  const first = calls[0]
  const usage = calls.reduce((acc, c) => addTokenUsage(acc, c), emptyTokenUsage())
  const cost = costSummary(calls.map((c) => c.costUsd))
  const baseTs = Math.min(...calls.map((c) => c.timestamp))

  // 按轮分组（server 返回时间 ASC，首现序即轮序）
  const turns = new Map<number, UsageLlmCall[]>()
  for (const c of calls) {
    const list = turns.get(c.turnIndex)
    if (list) list.push(c)
    else turns.set(c.turnIndex, [c])
  }

  // 归因面包屑：引擎/工作流域行有 executionId → 执行/节点链（phase2 KD6：trace=运行根）；
  // chat 域行走会话头。
  const crumbs = [
    first.org,
    first.workspaceId,
    first.executionId ? `执行 ${first.executionId}` : null,
    first.nodeId ? `节点 ${first.nodeId}` : null,
    first.workflowRef,
  ].filter(Boolean)

  return (
    <div data-testid="trace-tree" className="p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 font-bold text-pop-ink">
        <span>{first.sessionId ? `会话 ${first.sessionId}` : "会话 —"}</span>
        <span className="text-muted-foreground">trace {first.traceId ?? "—"}</span>
        {crumbs.length > 0 && <span className="text-muted-foreground">{crumbs.join(" / ")}</span>}
        <span>小计 {formatTokenCount(totalTokens(usage))} tokens</span>
        <span>{formatCost(cost.usd, cost.complete)}</span>
      </div>
      {[...turns.entries()].map(([turn, list]) => (
        <div key={turn} className="mt-1 ml-3 border-l-2 border-pop-bd pl-3">
          <div className="font-bold">轮 {turn}</div>
          {list.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 py-0.5 text-muted-foreground">
              <span className="font-mono">{c.model ?? "—"}</span>
              <span>第{c.callIndex + 1}次</span>
              <span>{c.timestamp === baseTs ? "±0" : `+${formatDuration(c.timestamp - baseTs)}`}</span>
              <span>{c.spanId ?? "—"}</span>
              <span>in {formatTokenCount(c.inputTokens)}</span>
              <span>out {formatTokenCount(c.outputTokens)}</span>
              <span>缓存读 {formatTokenCount(c.cacheReadTokens)}</span>
              <span>缓存写 {formatTokenCount(c.cacheCreationTokens)}</span>
              <span>ttft {formatDuration(c.ttftMs)}</span>
              <span>耗时 {formatDuration(c.durationMs)}</span>
              <span>{formatCost(c.costUsd)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
