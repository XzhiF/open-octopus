'use client'

// S6 owns this file —— 舰桥一行（v12 .rig 24px）：
//   ◇ 模型 ▾ · ◉ 42% 上下文 · ↑ 12.4k ↓ 3.1k · ¥ 1.28 本舱 · ◉ 在场 · 标准
//
// 所有读数都有真来源（plans §1.5）：
//   · 模型 / effort / 上下文窗口 ← chat（S5 从 composer 上报的进程级设置）；
//   · 上下文占用 ← chat.contextUsage（流式期间实时）；
//   · token ← chat.usage（回合结束才刷新，UI 注明）；
//   · 本舱 ¥ ← getCabinUsage(entryCabinId).grand.totals.cost.usd（30s 轮询，失败留上次值）；
//   · 在场 ← CockpitProvider.preferences（真实分钟档位）。
//
// chat === null（无主会话 / ChatPane 未挂）→ 每项显式「未就绪」并禁用。
// 绝不写 `--`，也不把缺失值写成 0。

import { useEffect, useRef } from 'react'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost } from '@/lib/format'
import { SessionCostChip } from '@/components/agent/chat/session-cost-chip'
import { CABIN_MAIN_IDENTITY } from '@/components/cabin/cabin-meta'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitContextPopover } from './CockpitContextPopover'
import { CockpitModelPopover } from './CockpitModelPopover'
import { CockpitPresencePopover } from './CockpitPresencePopover'
import { nextBridgeModel } from './rig-model'
import { useCabinUsage } from './use-cabin-usage'

export function CockpitBridge() {
  const { entryCabinId, chat } = useCockpitState()
  const { usage, stale } = useCabinUsage(entryCabinId)
  const currency = useBillingCurrency()

  // ⌘⇧M 循环三个真别名。只认 meta/ctrl + shift 的组合，单按 m 永远是输入；
  // 输入法合成中 / 长按重复不触发，避免和底栏 composer 抢键。
  const chatRef = useRef(chat)
  useEffect(() => {
    chatRef.current = chat
  }, [chat])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'm') return
      const api = chatRef.current
      if (!api) return
      event.preventDefault()
      api.setModel(nextBridgeModel(api.model))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const tokenUsage = chat?.usage ?? null
  const costUsd = usage?.grand.totals.cost.usd ?? null
  const costComplete = usage?.grand.totals.cost.complete ?? true
  const costLabel = costUsd == null ? '—' : formatCost(costUsd, costComplete, currency)
  const costTitle = stale
    ? usage
      ? '本舱累计消耗 · 上次读取失败，显示上次成功值'
      : '本舱累计消耗 · 读取失败'
    : '本舱累计消耗 · 30 秒刷新'

  return (
    <div className="ck12-rig" data-testid="cockpit-bridge" data-chat={chat ? 'ready' : 'pending'}>
      {chat ? (
        <CockpitModelPopover chat={chat} />
      ) : (
        <button type="button" className="ck12-rig-btn is-off" disabled data-testid="ck12-rig-model-off">
          <span className="ck12-rig-glyph">◇</span>
          <b>未就绪</b>
          <span className="ck12-rig-cv">▾</span>
        </button>
      )}

      <span className="ck12-rig-sep" />

      {chat ? (
        <CockpitContextPopover chat={chat} usage={usage} usageStale={stale} currency={currency} />
      ) : (
        <button type="button" className="ck12-rig-btn is-off" disabled data-testid="ck12-rig-context-off">
          <span className="ck12-rig-glyph">◉</span>
          <b>未就绪</b>
          <span className="ck12-rig-lbl">上下文</span>
        </button>
      )}

      <span className="ck12-rig-sep ck12-rig-sep-hide" />

      {chat ? (
        <span className="ck12-rig-tokens" data-testid="ck12-rig-tokens">
          {/* 直接复用 classic 的会话 token 角标（`tok 4.3M · ¥x ▾`，点开是账本）：
              全域不再自造 ↑/↓ 读数 —— 那既不等于账本总量，也和 classic 下方
              这块对不上（2026-11-14 用户）。 */}
          <SessionCostChip usage={tokenUsage} contextUsage={chat.contextUsage} placeholder />
        </span>
      ) : (
        <span
          className="ck12-rig-num ck12-rig-tokens is-off"
          aria-disabled="true"
          data-testid="ck12-rig-tokens-off"
        >
          <span className="ck12-rig-dim">tok</span>
          <b>未就绪</b>
        </span>
      )}

      <span className="ck12-rig-sep ck12-rig-sep-hide" />

      {/* 舱主对话身份（2026-11-14 用户）：从 composer 下方搬到舰桥，跟在模型 /
          token 后面 —— 底栏不再为它单独开一行。身份固定只读，取同一词表。 */}
      <span
        className="ck12-rig-who"
        data-testid="ck12-rig-identity"
        title={`舱主对话身份固定为${CABIN_MAIN_IDENTITY}，不可切换`}
      >
        <span className="ck12-rig-glyph" aria-hidden="true">✦</span>
        {CABIN_MAIN_IDENTITY}
      </span>

      <span className="ck12-rig-sep ck12-rig-sep-hide" />

      {chat ? (
        <span className="ck12-rig-num ck12-rig-cost" data-testid="ck12-rig-cost" title={costTitle}>
          <b>{costLabel}</b>
          <span className="ck12-rig-lbl">本舱</span>
        </span>
      ) : (
        <span
          className="ck12-rig-num ck12-rig-cost is-off"
          aria-disabled="true"
          data-testid="ck12-rig-cost-off"
        >
          <b>未就绪</b>
          <span className="ck12-rig-lbl">本舱</span>
        </span>
      )}

      <span className="ck12-rig-spacer" />

      {chat ? (
        <CockpitPresencePopover />
      ) : (
        <button type="button" className="ck12-rig-btn ck12-rig-pres is-off" disabled data-testid="ck12-rig-presence-off">
          <i aria-hidden="true" />
          <span>未就绪</span>
        </button>
      )}
    </div>
  )
}
