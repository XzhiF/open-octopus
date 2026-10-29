'use client'

// token 账四项明细（输入/输出/缓存读/缓存写）共享网格 —— TaskCostChip 弹层与
// 「消耗」窗口单源。配色/口径与 SessionCostLedger 一致（账本 totals 现算，
// 命中率/ctx 不在本组件：语义不同，别混）。

import { formatCost, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import type { LlmUsageSummary, ModelUsageBreakdown } from '@octopus/shared'

const GRID = 'grid grid-cols-2 gap-x-4'
const ROW = 'flex items-baseline justify-between gap-3 py-0.5 text-[11px]'
const LABEL = 'text-pop-dim'
const VALUE = 'font-black tabular-nums'

const SWATCH: Record<string, string> = {
  in: 'bg-pop-cyan',
  out: 'bg-pop-pink',
  cacheRead: 'bg-pop-green',
  cacheWrite: 'bg-pop-navy',
}

export function UsageTotalsGrid({ usage }: { usage: LlmUsageSummary }) {  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usage.usage
  return (
    <div className={GRID} data-testid="usage-totals-grid">
      <div className={ROW}>
        <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.in} mr-1.5`} />输入</span>
        <span className={VALUE}>{formatTokenCount(inputTokens)}</span>
      </div>
      <div className={ROW}>
        <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.out} mr-1.5`} />输出</span>
        <span className={VALUE}>{formatTokenCount(outputTokens)}</span>
      </div>
      <div className={ROW}>
        <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.cacheRead} mr-1.5`} />缓存读</span>
        <span className={VALUE}>{formatTokenCount(cacheReadTokens)}</span>
      </div>
      <div className={ROW}>
        <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.cacheWrite} mr-1.5`} />缓存写</span>
        <span className={VALUE}>{formatTokenCount(cacheCreationTokens)}</span>
      </div>
    </div>
  )
}

/**
 * 「按模型」分解行（2026-10-29 用户需求：chat 底部 chip 与作业坞「消耗」窗口
 * 都要能看到 token 花在哪些模型上）。按处理量降序；未定价模型显示 "—"。
 */
export function ModelBreakdownList({ models, className }: {
  models?: Record<string, ModelUsageBreakdown> | null
  className?: string
}) {
  const currency = useBillingCurrency()
  const rows = Object.entries(models ?? {})
    .map(([model, m]) => ({
      model,
      m,
      tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens,
    }))
    .sort((a, b) => b.tokens - a.tokens)
  if (rows.length === 0) return null
  return (
    <div className={className} data-testid="model-breakdown">
      <div className="mb-1 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">按模型</div>
      {rows.map(({ model, m, tokens }) => (
        <div key={model} className="flex items-baseline justify-between gap-3 py-0.5 text-[11px]" title={`${m.calls} 次请求`}>
          <span className="min-w-0 truncate text-pop-ink/85">{model}</span>
          <span className="shrink-0 font-mono text-[10px] text-pop-dim tabular-nums">
            {m.calls} 次 · {formatTokenCount(tokens)}
          </span>
          <span className="shrink-0 font-black tabular-nums">
            {formatCost(m.costUsd, m.costUsd !== null, currency)}
          </span>
        </div>
      ))}
    </div>
  )
}
