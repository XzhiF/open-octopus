'use client'

// Task-lifecycle cost chip — the task-thread version of SessionCostChip.
// Composer shows ONE number (the task total); the popover breaks it down by
// source (main chat / P1·R1 / fix round / archiving reflection).

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatCost, formatPercent, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import type { TaskUsagePayload } from '@/lib/tasks-api'
import { UsageTotalsGrid } from './usage-totals-grid'

const CHIP_CLASS =
  'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 font-mono text-[10.5px] leading-none tabular-nums transition-colors'

/** 来源行 tooltip：四项明细 + 请求数（「主对话」行 = 原会话 chip 的全部口径）。 */
function partTooltip(part: TaskUsagePayload['breakdown'][number]): string {
  const u = part.usage
  return `${part.totalCalls} 次请求 · 输入 ${formatTokenCount(u.inputTokens)} / 输出 ${formatTokenCount(u.outputTokens)} / 缓存读 ${formatTokenCount(u.cacheReadTokens)} / 缓存写 ${formatTokenCount(u.cacheCreationTokens)}`
}

export function TaskCostChip({
  usage,
  placeholder,
}: {
  usage?: TaskUsagePayload | null
  placeholder?: boolean
}) {
  const currency = useBillingCurrency()

  if (!usage || usage.summary.totalCalls === 0) {
    if (!placeholder) return null
    return (
      <span
        data-task-cost
        title="任务尚无用量"
        className={`${CHIP_CLASS} border-pop-bd/60 bg-pop-paper/40 text-pop-dim`}
      >
        task tok --
      </span>
    )
  }

  const { summary } = usage
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-task-cost
          title={`任务周期 token 账 · tok ${formatTokenCount(summary.totals.tokens)} · cache ${formatPercent(summary.totals.cacheHitRate, 1)} · 点击看各轮明细`}
          className={`${CHIP_CLASS} border-pop-cyan/40 bg-pop-cyan-soft text-pop-cyan hover:border-pop-cyan/70`}
        >
          <span className="text-pop-dim">task</span>
          {formatTokenCount(summary.totals.tokens)}
          <span className="text-pop-dim/60">·</span>
          {formatCost(summary.totals.cost.usd, summary.totals.cost.complete, currency)}
          <span className="text-pop-dim">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-3" side="top" align="start">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">TASK LEDGER · 任务周期</span>
          <span className="ml-auto font-mono text-[9px] text-pop-dim">{usage.breakdown.length} 个来源</span>
        </div>
        {/* 合计四项明细（2026-10-28：任务台账 = 账本全集，来源行 tooltip 看各趟） */}
        <div className="mb-2">
          <UsageTotalsGrid usage={summary} />
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {usage.breakdown.map((part) => {
            const key = `${part.kind}:${part.session_id ?? part.execution_id ?? part.label}`
            return (
              <div
                key={key}
                title={partTooltip(part)}
                className="flex items-center gap-2 rounded px-1 py-1 text-[10.5px] hover:bg-white/[0.04]"
              >
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${part.kind === 'chat' ? 'bg-pop-purple' : 'bg-pop-cyan'}`}
                />
                <span className="min-w-0 flex-1 truncate text-pop-dim">
                  {part.label}
                  {part.workflow_ref ? <span className="text-pop-dim/60"> · {part.workflow_ref}</span> : null}
                </span>
                <span className="font-mono tabular-nums text-pop-ink">{formatTokenCount(part.totals.tokens)}</span>
                <span className="w-16 text-right font-mono tabular-nums text-pop-dim">
                  {formatCost(part.totals.cost.usd, part.totals.cost.complete, currency)}
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-pop-bd pt-2">
          <span className="text-[11px] font-black text-pop-ink">合计</span>
          <span className="font-mono text-[11px] font-black text-pop-ink">{formatTokenCount(summary.totals.tokens)} tok</span>
          <span className="ml-auto font-mono text-[10px] text-pop-dim">
            cache {formatPercent(summary.totals.cacheHitRate, 1)} · {formatCost(summary.totals.cost.usd, summary.totals.cost.complete, currency)}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
