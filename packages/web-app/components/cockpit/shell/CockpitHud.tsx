'use client'

// v21（design 31 §3.7）· HUD —— 54px 指挥官抬头条。
//
//   ← │ 指挥官徽(32×36) + 身份 + CMDR 行 │ 舱籍 chip(32) │ SCENE pill(居中)
//     │ model chip(32) │ ▤ tok(24×27) │ ◈ ctx │ ¥ 消耗 │ ♪ ◐ ✦(32×36)
//
// 纪律：
//   · 读数全部来自真源（chat 遥测 / getCabinUsage / 舱籍）；拿不到就写「未就绪」，
//     绝不把缺失值写成 0。
//   · 导航入口只留最左 ←（应用需要退出舱）；其余入口迁到右栏「更多」。
//   · 数字用 tabular-nums；chrome 用 UI 字体，读数用 mono（与原型一致）。
//   · 「跃迁」（切下一幕）仍在右栏 / ⌥W；HUD 只显示当前幕。

import { useCallback, useRef, useState } from 'react'
import { THEMES, type CockpitTheme } from '@/components/cabin/cockpit'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost, formatTokenCount } from '@/lib/format'
import { CABIN_MAIN_IDENTITY } from '@/components/cabin/cabin-meta'
import { useCockpitEntry } from '../entry/use-cockpit-entry'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { CockpitProjectsPopover } from '../projects/CockpitProjectsPopover'
import { CockpitRepoBinder } from '../projects/CockpitRepoBinder'
import { useCabinProjects } from '../projects/use-cabin-projects'
import { CockpitCrewSettings } from '../crew/CockpitCrewSettings'
import {
  setCrewSettingsOpen,
  toggleCrewSettings,
  useCrewSettingsOpen,
} from '../crew/crew-settings'
import { CockpitModelPopover } from '../bridge/CockpitModelPopover'
import { useCabinUsage } from '../bridge/use-cabin-usage'
import { SCENES } from '../scene/scene-model'

const THEME_ORDER = Object.keys(THEMES) as CockpitTheme[]

/** 金额读数拆成「符号进六角、数字进 b」——原型 ¥ 徽 + 1.28。 */
function splitCost(label: string): { unit: string; value: string } {
  const match = label.match(/^(≈)?([¥$])(.+)$/)
  if (!match) return { unit: '¥', value: label }
  return { unit: `${match[1] ?? ''}${match[2]}`, value: match[3] }
}

export function CockpitHud() {
  const { prefs, applyPrefs } = useCockpit()
  const {
    entryCabinId, chat, openPanel, sceneIndex, travel,
  } = useCockpitState()
  const { exitCockpit } = useCockpitEntry()
  const cabinCtx = useCabinOptional()
  const cabinName = cabinCtx?.cabin?.name ?? '作战舱'
  const org = cabinCtx?.cabin?.org ?? null
  const { usage, stale } = useCabinUsage(entryCabinId)
  const currency = useBillingCurrency()

  const {
    projects, loading: projectsLoading, error: projectsError, refetch: refetchProjects,
  } = useCabinProjects(entryCabinId)
  const [bindOpen, setBindOpen] = useState(false)
  const settingsOpen = useCrewSettingsOpen()
  const xiyinBtnRef = useRef<HTMLButtonElement>(null)
  const closeSettings = useCallback(() => setCrewSettingsOpen(false), [])

  const cycleTheme = () => {
    const index = THEME_ORDER.indexOf(prefs.theme)
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length]
    applyPrefs({ ...prefs, theme: next })
  }

  const toggleSound = () => applyPrefs({ ...prefs, sound: !prefs.sound })

  // ── 读数（真源，缺值 → 未就绪）────────────────────────────────────────
  const ready = chat !== null
  const tokenTotal = chat?.usage?.totals.tokens ?? null
  const tokenLabel = tokenTotal == null ? '未就绪' : formatTokenCount(tokenTotal)
  const ctxPct = chat?.contextUsage?.percentage ?? null
  // 上下文 ±0.5% 内不显示小数（原型 42%）。
  const ctxLabel = ctxPct == null ? '未就绪' : `${Math.round(ctxPct)}%`
  const ctxTitle = chat?.contextUsage
    ? `上下文 ${formatTokenCount(chat.contextUsage.totalTokens)} / ${formatTokenCount(chat.contextUsage.maxTokens, 0)}`
    : '上下文占用 · 未就绪'

  const costUsd = usage?.grand.totals.cost.usd ?? null
  const costComplete = usage?.grand.totals.cost.complete ?? true
  const cost = splitCost(costUsd == null ? '—' : formatCost(costUsd, costComplete, currency))
  const costTitle = stale
    ? '本舱累计消耗 · 上次读取失败，显示上次成功值'
    : '本舱累计消耗 · 30 秒刷新 · 点开账本'

  const scene = SCENES[sceneIndex] ?? SCENES[0]

  return (
    <header className="ck12-hud" data-testid="cockpit-hud">
      {/* 唯一保留的导航入口：退出舱（原型没有，应用需要）。 */}
      <button
        type="button"
        className="ck12-hud-back"
        onClick={() => exitCockpit(entryCabinId)}
        title="返回作战舱"
        aria-label="← 返回作战舱"
        data-testid="cockpit-back"
      >
        ←
      </button>

      <div className="ck12-player" data-testid="cockpit-player">
        <span className="ck12-player-lv" aria-hidden="true">{CABIN_MAIN_IDENTITY.slice(0, 1)}</span>
        <span className="ck12-player-n">
          <b>{CABIN_MAIN_IDENTITY}</b>
          <span>CMDR · {org ?? '全域'}</span>
        </span>
      </div>

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

      <span className="ck12-hud-model" data-testid="cockpit-hud-model">
        {ready ? (
          <CockpitModelPopover chat={chat} />
        ) : (
          <span className="ck12-hud-modeloff" title="主会话未就绪">model <b>未就绪</b></span>
        )}
      </span>

      <span className="ck12-hudcur is-tok" title={tokenTotal == null ? '会话 token · 未就绪' : `本会话 ${tokenTotal.toLocaleString()} tokens`} data-testid="ck12-rig-tokens">
        <span className="ck12-hudcur-i" aria-hidden="true">▤</span>
        <b>{tokenLabel}</b>
      </span>

      <span className="ck12-hudcur is-ctx" title={ctxTitle} data-testid="ck12-rig-context">
        <span className="ck12-hudcur-i" aria-hidden="true">◈</span>
        <b>{ctxLabel}</b>
      </span>

      <button
        type="button"
        className="ck12-hudcur is-cost"
        title={costTitle}
        onClick={() => openPanel('ledger')}
        data-testid="ck12-rig-cost"
      >
        <span className="ck12-hudcur-i" aria-hidden="true">{cost.unit}</span>
        <b>{cost.value}</b>
      </button>

      <button
        type="button"
        className={`ck12-hudhex is-sound${prefs.sound ? ' is-on' : ' is-off'}`}
        aria-pressed={prefs.sound}
        onClick={toggleSound}
        title={`音效 ${prefs.sound ? '开' : '关'}（⌥M）`}
        data-testid="cockpit-sound"
      >
        ♪
      </button>
      <button
        type="button"
        className="ck12-hudhex is-theme"
        onClick={cycleTheme}
        title={`换色 · 当前 ${THEMES[prefs.theme].name}`}
        data-testid="cockpit-theme"
      >
        ◐
      </button>
      <button
        type="button"
        className="ck12-hudhex is-poses"
        onClick={() => openPanel('poses')}
        title="动作图鉴 · 12 姿态"
        data-testid="cockpit-poses-open"
      >
        ✦
      </button>

      {/* 汐音设置入口仍挂在指挥官徽旁的下拉（视觉上不新增按钮）。 */}
      <button
        ref={xiyinBtnRef}
        type="button"
        className="ck12-hud-settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => toggleCrewSettings()}
        title="汐音的设置（⌥X）"
        data-testid="cockpit-crew-settings-btn"
        aria-label="汐音的设置"
      >
        ⋯
      </button>

      <CockpitCrewSettings
        open={settingsOpen}
        anchor={xiyinBtnRef.current}
        onClose={closeSettings}
      />

      <CockpitRepoBinder
        open={bindOpen}
        cabinId={entryCabinId}
        cabinPath={entryCabinId === cabinCtx?.cabin?.id ? cabinCtx?.cabin?.path ?? null : null}
        projects={projects}
        onClose={() => setBindOpen(false)}
        onSaved={() => { refetchProjects() }}
      />
    </header>
  )
}
