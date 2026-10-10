'use client'

// 会话 token 账**明细 body**（票10 单源抽取）—— 原 SessionCostChip 的 PopoverContent
// 整段原样搬入：输入/输出/缓存读/缓存写 · 总和/命中率(ADR-0027)/ctx 占用/预估费用 ·
// 按模型 · 「完整台账」target=_blank（1e842875 行为随 body 白拿）。
// 宿主各自挂 PopoverContent（草稿 chip side=top/align=start；ready 右栏角标
// side=top/align=end + 60vh 滚）—— body 返回 Fragment，包装层零 DOM 差。
// 命中率口径别混：cache% = 账本 totals.cacheHitRate（读÷(读+写+新输入)），
// ctx% = SDK context_usage 窗口占用 —— 语义不同，不是同一数的两个显示。

import Link from 'next/link'
import { formatCost, formatPercent, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { ContextUsageData } from '@/lib/agent/types'

export interface SessionCostLedgerProps {
  usage: LlmUsageAggregates
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

export function SessionCostLedger({ usage, contextUsage }: SessionCostLedgerProps) {
  const currency = useBillingCurrency()
  const { totals, usage: u } = usage
  const models = Object.entries(usage.modelBreakdown)

  return (
    <>
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
        <Link href="/system/billing" target="_blank" rel="noopener" className="ml-auto text-pop-cyan hover:underline">完整台账 →</Link>
      </div>
    </>
  )
}
