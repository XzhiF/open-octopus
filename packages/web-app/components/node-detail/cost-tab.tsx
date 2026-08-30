"use client"

// agent / octopus_agent 详情弹窗「成本」页 —— 唯一实现，两处复用。
// 单一真相源 = llm_calls 聚合（usage=ledger 四路, modelBreakdown=每模型四路+calls+费用三态）。
// 口径与节点主行/监控面板一致：∑ = 输入+输出+缓存读+缓存写；⚡读/🗡写 单列。

import { formatCost, formatTokenCount } from "@/lib/format"
import type { LLMCallAggregates } from "@/lib/types"

interface CostTabProps {
  aggregates: LLMCallAggregates
}

function UsageCells({ u }: { u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } }) {
  const cr = u.cacheReadTokens ?? 0
  const cw = u.cacheCreationTokens ?? 0
  return (
    <span className="tabular-nums flex items-center gap-1.5 shrink-0">
      <span title="输入">↑{formatTokenCount(u.inputTokens ?? 0)}</span>
      <span title="输出">↓{formatTokenCount(u.outputTokens ?? 0)}</span>
      {cr > 0 && <span title="缓存读取">⚡{formatTokenCount(cr)}</span>}
      {cw > 0 && <span title="缓存创建">🗡️{formatTokenCount(cw)}</span>}
    </span>
  )
}

export function CostTab({ aggregates }: CostTabProps) {
  if (aggregates.totalCalls === 0) {
    return <div className="text-xs text-muted-foreground">暂无 LLM 调用数据</div>
  }
  const { usage, totals, totalCalls, toolCalls, modelBreakdown } = aggregates
  const models = Object.entries(modelBreakdown)

  return (
    <div className="space-y-3 text-xs">
      {/* 总计行：∑处理量(含缓存) + 四路明细 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">总计</span>
        <span className="tabular-nums font-medium" title="处理量（输入+输出+缓存读+缓存写）">∑{formatTokenCount(totals.tokens)}</span>
        <UsageCells u={usage} />
      </div>
      {/* 次数与费用：请求=llm_calls 行数；工具=不同 tool_call_id 数；费用三态（null → —） */}
      <div className="flex items-center gap-2 flex-wrap text-muted-foreground">
        <span className="tabular-nums">{totalCalls} 次请求</span>
        {toolCalls > 0 && (
          <>
            <span>·</span>
            <span className="tabular-nums">{toolCalls} 次工具调用</span>
          </>
        )}
        <span>·</span>
        <span className="tabular-nums font-medium text-amber-600 dark:text-amber-400">{formatCost(totals.cost.usd, totals.cost.complete)}</span>
      </div>

      {models.length > 0 && (
        <div className="border-t pt-2 space-y-1.5">
          <span className="text-muted-foreground">按模型</span>
          {models.map(([model, s]) => (
            <div key={model} className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate max-w-[180px]" title={model}>{model}</span>
              <UsageCells u={s} />
              <span className="tabular-nums text-muted-foreground">∑{formatTokenCount((s.inputTokens ?? 0) + (s.outputTokens ?? 0) + (s.cacheReadTokens ?? 0) + (s.cacheCreationTokens ?? 0))}</span>
              <span className="tabular-nums text-muted-foreground ml-auto shrink-0">{s.calls} calls · {formatCost(s.costUsd)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
