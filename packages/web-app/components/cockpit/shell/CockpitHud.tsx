'use client'

// HUD（v12 .hud，48px）：
//   左起：← 返回作战舱（第一个可聚焦元素，关闭/退出永远在左）→ 品牌 → 四统计；
//   右侧：☰ 编队（≤1120 才出现，只切 railOpen）· ⛶ 全域（当前视图标记）· ◐ 换色。
//
// 数字纪律（plans §1.5）：S1 没有编队数据 → 四统计一律「—」。绝不能写 0 冒充。
// counts.sessions 为 null（拿不到 /api/agent/sessions/running）时隐藏「分身」统计。

import { useCallback, useRef, useState } from 'react'
import { THEMES, type CockpitTheme } from '@/components/cabin/cockpit'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
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

const THEME_ORDER = Object.keys(THEMES) as CockpitTheme[]

function stat(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

export function CockpitHud() {
  const { prefs, applyPrefs } = useCockpit()
  const { entryCabinId, railOpen, setRailOpen, fx } = useCockpitState()
  const { exitCockpit } = useCockpitEntry()
  const { counts } = useCockpitFleet()
  const cabinCtx = useCabinOptional()
  // 全域只属于入口舱（2026-11-15）：读数 / 舱籍 / 绑定入口永远说这一个舱。
  const currentCabinId = entryCabinId
  const currentCabinName = cabinCtx?.cabin?.name ?? '作战舱'
  const {
    projects, loading: projectsLoading, error: projectsError, refetch: refetchProjects,
  } = useCabinProjects(currentCabinId)
  const [bindOpen, setBindOpen] = useState(false)
  const settingsOpen = useCrewSettingsOpen()
  const xiyinBtnRef = useRef<HTMLButtonElement>(null)
  const closeSettings = useCallback(() => setCrewSettingsOpen(false), [])

  const cycleTheme = () => {
    const index = THEME_ORDER.indexOf(prefs.theme)
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length]
    applyPrefs({ ...prefs, theme: next })
    fx.jump()
  }

  // counts 为 null（S1 / 还没接上）时保留「—」占位；有真值但没有分身来源时隐藏。
  const showSessions = counts === null || counts.sessions !== null

  return (
    <header className="ck12-hud" data-testid="cockpit-hud">
      <button
        type="button"
        className="ck12-ghost ck12-back"
        onClick={() => exitCockpit(entryCabinId)}
        title="返回作战舱"
      >
        ← 返回作战舱
      </button>

      <div className="ck12-brand">
        <span className="ck12-hex" aria-hidden="true">⬢</span>
        OCTOPUS
        <small>· 作战舱 · 全域</small>
      </div>

      <div className="ck12-hsep" />

      <div className="ck12-stat"><b className="ck12-c">{stat(counts?.run)}</b>运行中</div>
      <div className="ck12-stat"><b className="ck12-m">{stat(counts?.need)}</b>需要你</div>
      <div className="ck12-stat"><b>{stat(counts?.jobs)}</b>编队</div>
      {showSessions && (
        <div className="ck12-stat ck12-opt1"><b>{stat(counts?.sessions)}</b>分身</div>
      )}

      {/* 舱籍读数（v14）：当前舱关联了几个项目；0 项目 = 绑定入口。 */}
      <CockpitProjectsPopover
        cabinId={currentCabinId}
        cabinName={currentCabinName}
        projects={projects}
        loading={projectsLoading}
        error={projectsError}
        onRefetch={refetchProjects}
        onBind={() => setBindOpen(true)}
      />

      <div className="ck12-hud-right">
        <button
          type="button"
          className="ck12-ghost ck12-fleetbtn"
          aria-expanded={railOpen}
          aria-controls="ck12-fleet-rail"
          onClick={() => setRailOpen(!railOpen)}
        >
          ☰ 编队
        </button>
        <span className="ck12-ghost ck12-ghost-static" aria-current="page" title="当前就在全域视图">
          ⛶ 全域
        </span>
        <button
          type="button"
          className="ck12-ghost ck12-opt2"
          onClick={cycleTheme}
          title={`换色 · 当前 ${THEMES[prefs.theme].name}`}
        >
          ◐ 换色
        </button>
        {/* v13：跃迁有了看得见的入口（原来只有 ⌥W / 指令） */}
        <button
          type="button"
          className="ck12-ghost ck12-opt2"
          onClick={() => fx.jump()}
          title="跃迁：星流重新对齐（⌥W）"
          data-testid="cockpit-jump"
        >
          ⟳ 跃迁
        </button>
        {/* v13：汐音的设置唯一的入口；点立绘只负责说话 */}
        <button
          ref={xiyinBtnRef}
          type="button"
          className={`ck12-ghost${settingsOpen ? ' is-on' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => toggleCrewSettings()}
          title="汐音的设置（⌥X）"
          data-testid="cockpit-crew-settings-btn"
        >
          ◐ 汐音
        </button>
      </div>

      <CockpitCrewSettings
        open={settingsOpen}
        anchor={xiyinBtnRef.current}
        onClose={closeSettings}
      />

      <CockpitRepoBinder
        open={bindOpen}
        cabinId={currentCabinId}
        cabinPath={currentCabinId === entryCabinId ? cabinCtx?.cabin?.path ?? null : null}
        projects={projects}
        onClose={() => setBindOpen(false)}
        onSaved={() => { refetchProjects(); fx.jump() }}
      />
    </header>
  )
}
