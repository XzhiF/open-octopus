"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { BillingPriceTab } from "@/components/system/billing/billing-price-tab"
import { BillingLedgerTab } from "@/components/system/billing/billing-ledger-tab"

/**
 * 系统管理 · Token 计费（KD10）—— 页内两 Tab：计费明细（默认）| 价格配置。
 * 明细 Tab = 票 06；价格配置 Tab = 票 05。
 */

type TabKey = "ledger" | "price"

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "ledger", label: "计费明细" },
  { key: "price", label: "价格配置" },
]

export default function BillingPage() {
  const [tab, setTab] = useState<TabKey>("ledger")

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
        {tab === "ledger" ? <BillingLedgerTab /> : <BillingPriceTab />}
      </div>
    </div>
  )
}
