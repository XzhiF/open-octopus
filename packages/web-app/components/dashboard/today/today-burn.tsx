"use client"

import { formatCost, formatPercent, formatTokenCount } from "@/lib/format"
import { useBillingCurrency } from "@/lib/billing-currency"
import type { TodayDigest } from "@/lib/today"

/**
 * ① 今日总消耗 —— 一屏顶部唯一的「数字块」，紧凑双行（数字行 + 来源条）。
 * 口径：账本 llm_calls 当天窗口；成本三态（未定价显示 —，部分定价 ≈）。
 */

const SPLIT_META: Record<TodayDigest["consumption"]["split"][number]["bucket"], { label: string; color: string }> = {
  chat: { label: "对话", color: "var(--pop-cyan)" },
  task: { label: "任务", color: "var(--pop-amber)" },
  system: { label: "系统", color: "var(--pop-bd)" },
}

export function TodayBurn({ consumption }: { consumption: TodayDigest["consumption"] }) {
  const display = useBillingCurrency()
  const { tokens, input_tokens, output_tokens, calls, cost, cache_hit_rate, cache_saved, split } = consumption
  const visibleSplit = split.filter((s) => s.tokens > 0)

  return (
    <section
      aria-label="今日总消耗"
      className="mt-2.5 flex flex-col gap-[5px] rounded-[12px] border-[1.5px] border-pop-bd bg-gradient-to-b from-[#1E1E25] to-pop-paper px-4 py-2 shadow-pop"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[9px] uppercase tracking-[0.12em] text-pop-dim">今日总消耗</span>
        <span className="text-[22px] font-black leading-none tracking-[-0.04em]">
          {formatTokenCount(tokens, 2)}
          <em className="ml-1 text-[9.5px] font-bold not-italic tracking-[0.06em] text-pop-dim">tokens</em>
        </span>
        <span className="text-[9px] text-pop-dim">
          输入 {formatTokenCount(input_tokens, 2)} · 输出 {formatTokenCount(output_tokens, 2)} · {calls} 次调用
        </span>

        <div className="ml-auto flex items-baseline gap-3.5 text-[9px] text-pop-dim">
          <span>
            <b className="mr-1 text-[13px] font-black tracking-[-0.02em] text-pop-ink">
              {formatCost(cost.usd, cost.complete, display)}
            </b>
            估计成本
          </span>
          <span>
            <b className="mr-1 text-[13px] font-black tracking-[-0.02em] text-pop-ink">{formatPercent(cache_hit_rate, 0)}</b>
            缓存命中
          </span>
          <span>
            <b className="mr-1 text-[13px] font-black tracking-[-0.02em] text-pop-ink">
              {formatCost(cache_saved.usd, cache_saved.complete, display)}
            </b>
            缓存省下
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex h-[4px] flex-1 overflow-hidden rounded-full border border-pop-bd bg-pop-inset"
          aria-label="消耗来源"
        >
          {visibleSplit.map((part) => (
            <i
              key={part.bucket}
              className="block h-full"
              style={{ width: `${part.share * 100}%`, background: SPLIT_META[part.bucket].color }}
            />
          ))}
        </div>
        <div className="flex flex-none items-center gap-2.5 text-[8.5px] text-pop-dim">
          {visibleSplit.map((part) => (
            <span key={part.bucket} className="flex items-center gap-1">
              <i className="h-[6px] w-[6px] rounded-[2px]" style={{ background: SPLIT_META[part.bucket].color }} />
              {SPLIT_META[part.bucket].label} {Math.round(part.share * 100)}%
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}