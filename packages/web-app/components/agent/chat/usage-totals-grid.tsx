'use client'

// token 账四项明细（输入/输出/缓存读/缓存写）共享网格 —— TaskCostChip 弹层与
// 「消耗」窗口单源。配色/口径与 SessionCostLedger 一致（账本 totals 现算，
// 命中率/ctx 不在本组件：语义不同，别混）。

import { formatTokenCount } from '@/lib/format'
import type { LlmUsageSummary } from '@octopus/shared'

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

export function UsageTotalsGrid({ usage }: { usage: LlmUsageSummary }) {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usage.usage
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
