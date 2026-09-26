'use client'

// 展示币种单源（v49）：角标/看板 chip 这类小面积金额要跟随计费设置
// （billing_setting.display_currency + usd_to_cny），但每个组件各自 GET /settings
// 会把一次页面渲染打成 N 次请求 —— 这里做模块级单飞缓存 + 订阅，
// 计费设置保存处调 invalidateBillingCurrency() 让全站角标立刻换币。
//
// 兜底值与服务端 SETTING_DEFAULTS 同值（CNY / 7.0）：未加载完成时不会先闪一个
// 与最终态不同币种的数字（默认配置下首帧即终态）。

import { useEffect, useState } from "react"
import { getSettings, type BillingSettings } from "./billing-api"
import type { CostDisplay } from "./format"

const FALLBACK: CostDisplay = { currency: "CNY", rate: 7 }

let cached: CostDisplay | null = null
let inflight: Promise<CostDisplay> | null = null
const subscribers = new Set<(next: CostDisplay) => void>()

function fromSettings(s: BillingSettings): CostDisplay {
  const rate = Number(s.usd_to_cny)
  return {
    currency: s.display_currency === "USD" ? "USD" : "CNY",
    rate: Number.isFinite(rate) && rate > 0 ? rate : FALLBACK.rate,
  }
}

/** 同步读当前展示币种（未加载 → 服务端默认值）。 */
export function billingCurrency(): CostDisplay {
  return cached ?? FALLBACK
}

/** 单飞拉取；失败保持旧值（拿不到设置就按上一次/默认继续，不炸界面）。 */
export function refreshBillingCurrency(): Promise<CostDisplay> {
  if (inflight) return inflight
  inflight = getSettings()
    .then((s) => {
      cached = fromSettings(s)
      for (const cb of subscribers) cb(cached)
      return cached
    })
    .catch(() => billingCurrency())
    .finally(() => { inflight = null })
  return inflight
}

/** 设置保存后调用：清缓存并重拉，订阅中的组件即时换币。 */
export function invalidateBillingCurrency(): void {
  cached = null
  void refreshBillingCurrency()
}

export function useBillingCurrency(): CostDisplay {
  const [display, setDisplay] = useState<CostDisplay>(billingCurrency)
  useEffect(() => {
    const cb = (next: CostDisplay) => setDisplay(next)
    subscribers.add(cb)
    if (!cached) void refreshBillingCurrency()
    return () => { subscribers.delete(cb) }
  }, [])
  return display
}
