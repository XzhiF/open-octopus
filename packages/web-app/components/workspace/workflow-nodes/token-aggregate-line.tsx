"use client"

// 节点卡片主行聚合口径（全站唯一）：模型 · ∑处理量 · N次 · 费用。
// agent / octopus_agent（type-shell）、子执行（execution-node）、swarm 共用，
// 与监控面板「处理量·含缓存」同口径可互相印证；费用走 C3 ledger 三态（null → —，不焊假 0）。
// 每模型/缓存明细不在这里——那是点开弹窗（TokenUsageDisplay）的职责。

import { cn } from "@/lib/utils"
import { formatTokenCount, formatCost } from "@/lib/format"
import type { TokenUsage } from "@/lib/types"

export interface TokenAggregateLineProps {
  /** 单条聚合 usage 或每模型列表；内部求 ∑ 并折叠模型标签（多模型 → "首模型 +N"）。 */
  usage?: TokenUsage | TokenUsage[] | null
  /** LLM 请求次数（节点 = llm_calls 行数；执行 = node_end.turnCount）。 */
  requestCount?: number
  /** 显式费用优先；省略时取单条 usage.costUsd。undefined = 不渲染费用段。 */
  costUsd?: number | null
  costComplete?: boolean
  isRunning?: boolean
  className?: string
}

export function TokenAggregateLine({
  usage, requestCount, costUsd, costComplete = true, isRunning, className,
}: TokenAggregateLineProps) {
  const list = usage == null ? [] : Array.isArray(usage) ? usage : [usage]
  const total = list.reduce(
    (s, u) => s + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0), 0)
  // 显式 costUsd 优先；否则取单条 usage 自带的 ledger 三态（含 complete 标记）
  const single = list.length === 1 ? list[0] : undefined
  const cost = costUsd !== undefined ? costUsd : single?.costUsd
  const complete = costUsd !== undefined ? costComplete : (single?.costComplete ?? costComplete)
  if (total === 0 && !requestCount && cost == null) return null

  const models = Array.from(new Set(list.map(u => u.model).filter(Boolean)))
  const modelLabel = models.length === 0 ? null : models.length === 1 ? models[0] : `${models[0]} +${models.length - 1}`

  return (
    <div className={cn("text-xs tabular-nums flex items-center gap-1.5", isRunning ? "text-amber-600 font-medium" : "text-muted-foreground", className)}>
      {modelLabel && <span className="font-medium truncate max-w-[150px]" title={models.join(" / ")}>{modelLabel}</span>}
      {total > 0 && <span title="处理量（输入+输出+缓存读+缓存写）">∑{formatTokenCount(total)}</span>}
      {!!requestCount && <span title="LLM 请求次数">{requestCount}次</span>}
      {cost != null && <span>{formatCost(cost, complete)}</span>}
      {isRunning && <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />}
    </div>
  )
}
