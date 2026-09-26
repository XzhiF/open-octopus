'use client'

// 会话 token 角标（v49）—— 挂在 composer 控制条 ctx 之后，点开是这一会话的账本明细。
// 数据 = GET /api/sessions/:id/llm-calls（llm_calls 账本 + 查询时派生的钱）。
// 两个百分比不是一回事，别混：cache% 取账本 totals.cacheHitRate（缓存复用率），
// ctx% 取 SDK context_usage 的窗口占用 —— 同源同值的巧合没有，语义也不同。

import Link from 'next/link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatCost, formatPercent, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { ContextUsageData } from '@/lib/agent/types'

interface SessionCostChipProps {
  usage?: LlmUsageAggregates | null | undefined
  /** 窗口占用（SSE context_usage）—— 只进明细，不参与账本口径。 */
  contextUsage?: ContextUsageData | null
}

const ROW = 'flex items-baseline justify-between gap-3 py-0.5 text-[11px]'
const LABEL = 'text-pop-dim'
const VALUE = 'font-black tabular-nums'
const SWATCH: Record<string, string> = {
  in: 'bg-pop-cyan',
  out: 'bg-pop-pink',
  cacheRead: 'bg-pop-green',
  cacheWrite: 'bg-pop-navy',
}

export function SessionCostChip({ usage, contextUsage }: SessionCostChipProps) {
  // 无账本 = 不渲染，也不去拉计费设置（外层先短路，币种 hook 留给内层）。
  if (!usage || usage.totalCalls === 0) return null
  return <SessionCostChipBody usage={usage} contextUsage={contextUsage} />
}

function SessionCostChipBody({ usage, contextUsage }: Required<SessionCostChipProps>) {
  const currency = useBillingCurrency()
  const { totals, usage: u } = usage
  const models = Object.entries(usage.modelBreakdown)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-session-cost
          className="shrink-0 rounded-full border border-pop-bd bg-pop-bg/70 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-pop-ink transition-colors hover:border-pop-pink hover:text-pop-pink"
        >
          <span className="text-pop-dim">tok </span>{formatTokenCount(totals.tokens)}
          <span className="text-pop-dim"> cache </span>
          <span className="text-pop-green">{formatPercent(totals.cacheHitRate, 1)}</span>
          <span className="text-pop-dim"> </span>{formatCost(totals.cost.usd, totals.cost.complete, currency)}
          <span className="text-pop-dim"> ▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" side="top" align="start">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-xs font-black">本会话 token 账</span>
          <span className="text-[10px] text-pop-dim tabular-nums">{usage.totalCalls} 次请求</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4">
          <div className={ROW}>
            <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.in} mr-1.5`} />输入</span>
            <span className={VALUE}>{formatTokenCount(u.inputTokens)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.out} mr-1.5`} />输出</span>
            <span className={VALUE}>{formatTokenCount(u.outputTokens)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.cacheRead} mr-1.5`} />缓存读</span>
            <span className={VALUE}>{formatTokenCount(u.cacheReadTokens)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}><i className={`inline-block size-2 rounded-sm ${SWATCH.cacheWrite} mr-1.5`} />缓存写</span>
            <span className={VALUE}>{formatTokenCount(u.cacheCreationTokens)}</span>
          </div>
        </div>
        <div className="my-2 h-px bg-pop-bd" />
        <div className={ROW}>
          <span className={LABEL}>总和</span>
          <span className={VALUE}>{formatTokenCount(totals.tokens)}</span>
        </div>
        <div className={ROW}>
          <span className={LABEL}>缓存命中率</span>
          <span className={`${VALUE} text-pop-green`}>{formatPercent(totals.cacheHitRate, 1)}</span>
        </div>
        {contextUsage && (
          <div className={ROW}>
            <span className={LABEL}>ctx 占用</span>
            <span className={`${VALUE} text-pop-pink`}>
              {`${formatPercent(contextUsage.percentage / 100)} · ${formatTokenCount(contextUsage.totalTokens)} / ${formatTokenCount(contextUsage.maxTokens)}`}
            </span>
          </div>
        )}
        <div className={ROW}>
          <span className={LABEL}>预估费用</span>
          <span className={`${VALUE} text-sm text-pop-yellow`}>{formatCost(totals.cost.usd, totals.cost.complete, currency)}</span>
        </div>
        {models.length > 0 && (
          <>
            <div className="my-2 h-px bg-pop-bd" />
            {models.map(([model, m]) => (
              <div key={model} className="flex items-baseline justify-between gap-3 py-0.5 text-[11px]">
                <span className="truncate">{model}</span>
                <span className="shrink-0 text-[10px] text-pop-dim tabular-nums">
                  {m.calls} 次 · {formatTokenCount(m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens)}
                </span>
                <span className="shrink-0 font-black tabular-nums">
                  {formatCost(m.costUsd, m.costUsd !== null, currency)}
                </span>
              </div>
            ))}
          </>
        )}
        <div className="mt-2 flex items-center gap-2 border-t border-dashed border-pop-bd pt-2 text-[10px] text-pop-dim">
          <span>单价 = 每 1M token · 现算不落库</span>
          <Link href="/system/billing" className="ml-auto text-pop-cyan hover:underline">完整台账 →</Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
