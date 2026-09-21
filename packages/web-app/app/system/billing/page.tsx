"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { BillingPriceTab } from "@/components/system/billing/billing-price-tab"
import { BillingLedgerTab } from "@/components/system/billing/billing-ledger-tab"
import { BillingReportTab } from "@/components/system/billing/billing-report-tab"
import type { BillingDrillDown } from "@/lib/billing-api"

/**
 * 系统管理 · Token 计费（KD10）—— 页内三 Tab：计费明细（默认）| 价格配置 | 报表。
 * 明细 Tab = 票 06；价格配置 Tab = 票 05；报表 Tab = billing-report-3 票 03
 * （区间选择 + 汇总卡 + 趋势；分布/排行由同批票 04 续填）。
 * 票04 联动：报表条目点击 → 记 drill + 切明细 Tab；明细挂载即应用筛选（drillApplied 复位）。
 */

type TabKey = "ledger" | "price" | "report"

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "ledger", label: "计费明细" },
  { key: "price", label: "价格配置" },
  { key: "report", label: "报表" },
]

export default function BillingPage() {
  const [tab, setTab] = useState<TabKey>("ledger")
  const [drill, setDrill] = useState<BillingDrillDown | null>(null)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2 border-b-2 border-pop-bd bg-pop-paper">
        <h1 className="text-lg font-black mr-4">Token 计费</h1>
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition-all",
              tab === t.key
                ? "border-2 border-pop-bd bg-pop-yellow font-black text-pop-ink"
                : "border-2 border-transparent font-bold text-pop-dim hover:bg-accent hover:text-pop-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === "ledger"
          ? <BillingLedgerTab drill={drill} onDrillConsumed={() => setDrill(null)} />
          : tab === "report"
            ? <BillingReportTab onDrill={(d) => { setDrill(d); setTab("ledger") }} />
            : <BillingPriceTab />}
      </div>
    </div>
  )
}
