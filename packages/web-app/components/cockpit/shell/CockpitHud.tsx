'use client'

// v21 二轮（原型 cockpit-v21.html · HUD）—— 54px 抬头条：
//
//   [← 经典模式] │ 舱籍 chip(32) │ SCENE pill(居中) │ ▤ tok │ ◈ ctx │ ¥ 消耗
//
// 纪律：
//   · 读数全部来自真源（chat 遥测 / getCabinUsage / 舱籍）；拿不到就写「未就绪」，
//     绝不把缺失值写成 0。
//   · 右上不再有模型切换与 ♪ ◐ ✦：模型 / 上下文 / 会话 token 明细都在通讯台头部
//     （MODEL / CTX / TOKEN 下拉），消耗完整账在右栏「消耗」；设置从「更多 → 设置」进。
//   · 三枚读数只读：不可点、无所指弹层（原型 .cur cursor:default）。
//   · v21 四轮：删掉原型左上的指挥官徽（16 / 指挥官 / CMDR·ID —— 偏高且无信息量，
//     与右侧 32px chip 不齐）；导航只留一枚同高的「经典模式」返回钮。

import { useCallback, useState } from 'react'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost, formatTokenCount } from '@/lib/format'
import { useCockpitEntry } from '../entry/use-cockpit-entry'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { CockpitProjectsPopover } from '../projects/CockpitProjectsPopover'
import { CockpitRepoBinder } from '../projects/CockpitRepoBinder'
import { useCabinProjects } from '../projects/use-cabin-projects'
import { useCabinUsage } from '../bridge/use-cabin-usage'
import { SCENES } from '../scene/scene-model'

/** 金额读数拆成「符号进六角、数字进 b」——原型 ¥ 徽 + 1.28。 */
function splitCost(label: string): { unit: string; value: string } {
  const match = label.match(/^(≈)?([¥$])(.+)$/)
  if (!match) return { unit: '¥', value: label }
  return { unit: `${match[1] ?? ''}${match[2]}`, value: match[3] }
}

export function CockpitHud() {
  const { entryCabinId, chat, sceneIndex, travel } = useCockpitState()
  const { exitCockpit } = useCockpitEntry()
  const cabinCtx = useCabinOptional()
  const cabinName = cabinCtx?.cabin?.name ?? '作战舱'
  const { usage, stale } = useCabinUsage(entryCabinId)
  const currency = useBillingCurrency()

  const {
    projects, loading: projectsLoading, error: projectsError, refetch: refetchProjects,
  } = useCabinProjects(entryCabinId)
  const [bindOpen, setBindOpen] = useState(false)
  const closeBinder = useCallback(() => setBindOpen(false), [])

  // ── 读数（真源，缺值 → 未就绪）────────────────────────────────────────
  const tokenTotal = chat?.usage?.totals.tokens ?? null
  const tokenLabel = tokenTotal == null ? '未就绪' : formatTokenCount(tokenTotal)
  const ctxPct = chat?.contextUsage?.percentage ?? null
  const ctxLabel = ctxPct == null ? '未就绪' : `${Math.round(ctxPct)}%`
  const ctxTitle = chat?.contextUsage
    ? `上下文 ${formatTokenCount(chat.contextUsage.totalTokens)} / ${formatTokenCount(chat.contextUsage.maxTokens, 0)} · 只读（明细在通讯台头部 CTX）`
    : '上下文占用 · 未就绪（明细在通讯台头部 CTX）'

  const costUsd = usage?.grand.totals.cost.usd ?? null
  const costComplete = usage?.grand.totals.cost.complete ?? true
  const cost = splitCost(costUsd == null ? '—' : formatCost(costUsd, costComplete, currency))
  const costTitle = stale
    ? '本舱累计消耗 · 上次读取失败，显示上次成功值'
    : '本舱累计消耗 · 只读（完整账在右栏 消耗）'

  const scene = SCENES[sceneIndex] ?? SCENES[0]

  return (
    <header className="ck12-hud" data-testid="cockpit-hud">
      {/* 唯一保留的导航入口：回 classic 舱页。高度与舱籍 chip 同为 32px，
          左组（经典 / 舱籍）与右组（SCENE / 三读数）在同一条中线上。 */}
      <button
        type="button"
        className="ck12-hud-classic"
        onClick={() => exitCockpit(entryCabinId)}
        title="返回 classic 模式（作战舱）"
        aria-label="返回 classic 模式（作战舱）"
        data-testid="cockpit-back"
      >
        <span className="ck12-hud-classic-i" aria-hidden="true">←</span>
        <b>经典模式</b>
      </button>

      <CockpitProjectsPopover
        cabinId={entryCabinId}
        cabinName={cabinName}
        projects={projects}
        loading={projectsLoading}
        error={projectsError}
        onRefetch={refetchProjects}
        onBind={() => setBindOpen(true)}
      />

      <button
        type="button"
        className="ck12-sceneread"
        onClick={() => travel()}
        title={`当前 ${scene.name} · 点击跃迁到下一幕`}
        data-testid="cockpit-scene-pill"
      >
        SCENE <b>{scene.name}</b>
        <span>{scene.coord}</span>
      </button>

      <span
        className="ck12-hudcur is-tok"
        title={tokenTotal == null ? '本会话 token · 未就绪（明细在通讯台头部 TOKEN）' : `本会话 ${tokenTotal.toLocaleString()} tokens · 只读（明细在通讯台头部 TOKEN）`}
        data-testid="ck12-rig-tokens"
      >
        <span className="ck12-hudcur-i" aria-hidden="true">▤</span>
        <b>{tokenLabel}</b>
      </span>

      <span className="ck12-hudcur is-ctx" title={ctxTitle} data-testid="ck12-rig-context">
        <span className="ck12-hudcur-i" aria-hidden="true">◈</span>
        <b>{ctxLabel}</b>
      </span>

      <span className="ck12-hudcur is-cost" title={costTitle} data-testid="ck12-rig-cost">
        <span className="ck12-hudcur-i" aria-hidden="true">{cost.unit}</span>
        <b>{cost.value}</b>
      </span>

      <CockpitRepoBinder
        open={bindOpen}
        cabinId={entryCabinId}
        cabinPath={entryCabinId === cabinCtx?.cabin?.id ? cabinCtx?.cabin?.path ?? null : null}
        projects={projects}
        onClose={closeBinder}
        onSaved={() => { refetchProjects() }}
      />
    </header>
  )
}
