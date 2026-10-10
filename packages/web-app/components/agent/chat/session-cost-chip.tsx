'use client'

// 会话 token 角标（v49）—— 挂在 composer 控制条 ctx 之后，点开是这一会话的账本明细。
// 数据 = GET /api/sessions/:id/llm-calls（llm_calls 账本 + 查询时派生的钱）。
// 两个百分比不是一回事，别混：cache% 取账本 totals.cacheHitRate（缓存复用率），
// ctx% 取 SDK context_usage 的窗口占用 —— 同源同值的巧合没有，语义也不同。
// 明细 body 已于票10 抽成 SessionCostLedger 单源（ready 右栏角标共用同一套 JSX）——
// 本文件只剩 Popover 壳 + 触发钮，渲染逐字不变（既有 chip 测试为回归证）。

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SessionCostLedger } from './session-cost-ledger'
import { formatCost, formatPercent, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { ContextUsageData } from '@/lib/agent/types'

interface SessionCostChipProps {
  usage?: LlmUsageAggregates | null | undefined
  /** 窗口占用（SSE context_usage）—— 只进明细，不参与账本口径。 */
  contextUsage?: ContextUsageData | null
}

export function SessionCostChip({ usage, contextUsage }: SessionCostChipProps) {
  // 无账本 = 不渲染，也不去拉计费设置（外层先短路，币种 hook 留给内层）。
  if (!usage || usage.totalCalls === 0) return null
  return <SessionCostChipBody usage={usage} contextUsage={contextUsage} />
}

function SessionCostChipBody({ usage, contextUsage }: Required<SessionCostChipProps>) {
  const currency = useBillingCurrency()
  const { totals } = usage

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
        <SessionCostLedger usage={usage} contextUsage={contextUsage} />
      </PopoverContent>
    </Popover>
  )
}
