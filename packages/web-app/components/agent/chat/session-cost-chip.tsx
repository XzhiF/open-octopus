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

// 原型 cost-chip：22px 胶囊、等宽字、无粗体；角标只留 tok + 费用，
// cache 命中率进 title 与明细（同一信息分层，避免 chip 过宽）。
const CHIP_CLASS =
  'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 font-mono text-[10.5px] leading-none tabular-nums transition-colors'

interface SessionCostChipProps {
  usage?: LlmUsageAggregates | null | undefined
  /** 窗口占用（SSE context_usage）—— 只进明细，不参与账本口径。 */
  contextUsage?: ContextUsageData | null
  /** 空会话占位：无账本时也渲染同款 `tok --`（对话首页 composer 用）。 */
  placeholder?: boolean
}

export function SessionCostChip({ usage, contextUsage, placeholder }: SessionCostChipProps) {
  // 无账本 = 默认不渲染，也不去拉计费设置（币种 hook 留给内层）。
  if (!usage || usage.totalCalls === 0) {
    if (!placeholder) return null
    return (
      <span
        data-session-cost
        title="暂无会话用量"
        className={`${CHIP_CLASS} border-pop-bd/60 bg-pop-paper/40 text-pop-dim`}
      >
        tok --
      </span>
    )
  }
  return <SessionCostChipBody usage={usage} contextUsage={contextUsage} />
}

function SessionCostChipBody({
  usage,
  contextUsage,
}: {
  usage: LlmUsageAggregates
  contextUsage?: ContextUsageData | null
}) {
  const currency = useBillingCurrency()
  const { totals } = usage

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-session-cost
          title={`本会话 token 账 · tok ${formatTokenCount(totals.tokens)} · cache ${formatPercent(totals.cacheHitRate, 1)} · 点击看明细`}
          className={`${CHIP_CLASS} border-pop-bd bg-pop-paper/60 text-pop-cyan hover:border-pop-cyan/60 hover:bg-pop-cyan-soft`}
        >
          <span className="text-pop-dim">tok </span>
          {formatTokenCount(totals.tokens)}
          <span className="text-pop-dim/60">·</span>
          {formatCost(totals.cost.usd, totals.cost.complete, currency)}
          <span className="text-pop-dim">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" side="top" align="start">
        <SessionCostLedger usage={usage} contextUsage={contextUsage} />
      </PopoverContent>
    </Popover>
  )
}
