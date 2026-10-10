// packages/web-app/components/tasks/run-console/ready-token-badge.tsx
//
// 票10（原型 ⓬ railReady .tok-meter/.tok-chip.rail）—— ready 控制台右栏「⚡ 触发」
// 上方的常驻 token 账角标：数据 = 草稿期会话（task.source_chat_session_id）的
// GET /api/sessions/:id/llm-calls（fetchSessionLLMCalls 既有 helper，零新端点）。
// 点开 = Radix Popover 浮层（portal 挂 body，天然不推挤右栏布局；再点/点外/Esc
// 三出口随 Radix 白拿，原型「✕/再点/点外」真版等价），明细 = SessionCostLedger
// 单源体（与草稿 SessionCostChip 同一套 JSX，「完整台账」target=_blank 随 body 白拿）。
//
// 短路纪律（仿 chip）：无会话 id → 不 fetch 不渲染；账本空（totalCalls=0，
// 含取数失败/404 的零值兜底同形）或 reject 静默 → 角标不渲染 —— 右栏永不开空壳，
// 也不出现「tok 0 / ¥0」假数据。

"use client"

import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SessionCostLedger } from "@/components/agent/chat/session-cost-ledger"
import { formatCost, formatPercent, formatTokenCount } from "@/lib/format"
import { useBillingCurrency } from "@/lib/billing-currency"
import { fetchSessionLLMCalls } from "@/lib/observability-api"
import type { LlmUsageAggregates } from "@octopus/shared"

export function ReadyTokenBadge({ sessionId }: { sessionId: string | null | undefined }) {
  const [usage, setUsage] = useState<LlmUsageAggregates | null>(null)

  useEffect(() => {
    if (!sessionId) { setUsage(null); return }
    let alive = true
    void fetchSessionLLMCalls(sessionId)
      .then((res) => { if (alive) setUsage(res.aggregates) })
      .catch(() => { /* 加载失败静默：不渲染角标、不砸右栏（fetchSessionLLMCalls 对 !res.ok
                         已兜零值走空账短路，这里只兜网络层抛错）。 */ })
    return () => { alive = false }
  }, [sessionId])

  // 三态短路：无缝 / 账未回 / 空账 → 整枚不渲染（无空壳）。
  if (!sessionId || !usage || usage.totalCalls === 0) return null

  return <ReadyTokenBadgePopover usage={usage} />
}

// 触发钮 = 草稿 chip 同形制（tok/cache/成本/▾），rail 版铺满栏宽、两端对齐
//（原型 .tok-chip.rail{width:100%;justify-content:space-between}）。
function ReadyTokenBadgePopover({ usage }: { usage: LlmUsageAggregates }) {
  const currency = useBillingCurrency()
  const { totals } = usage
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="ready-token-badge"
          title="点开/收回 token 账台（草稿期会话）"
          className="flex w-full items-baseline justify-between gap-1 rounded-full border border-pop-bd bg-pop-bg/70 px-2.5 py-1 text-[10px] font-black tabular-nums text-pop-ink transition-colors hover:border-pop-pink hover:text-pop-pink"
        >
          <span><span className="text-pop-dim">tok </span>{formatTokenCount(totals.tokens)}</span>
          <span><span className="text-pop-dim">cache </span><span className="text-pop-green">{formatPercent(totals.cacheHitRate, 1)}</span></span>
          <span>{formatCost(totals.cost.usd, totals.cost.complete, currency)}</span>
          <span className="text-pop-dim">▾ 展开</span>
        </button>
      </PopoverTrigger>
      {/* 浮层盖界不推挤（Radix portal）；rail 贴右缘 → align=end 让面板右缘对齐角标
          （原型 placeRcPanel：panel.right = chip.right）。 */}
      <PopoverContent className="w-80 max-h-[60vh] overflow-y-auto p-3" side="top" align="end">
        <SessionCostLedger usage={usage} />
      </PopoverContent>
    </Popover>
  )
}
