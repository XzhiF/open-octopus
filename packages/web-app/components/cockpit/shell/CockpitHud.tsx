'use client'

// HUD（v12 .hud，48px）：
//   左起：← 返回作战舱（第一个可聚焦元素，关闭/退出永远在左）→ 品牌 → 四统计；
//   右侧：☰ 编队（≤1120 才出现，只切 railOpen）· ⛶ 全域（当前视图标记）· ◐ 换色。
//
// 数字纪律（plans §1.5）：S1 没有编队数据 → 四统计一律「—」。绝不能写 0 冒充。
// counts.sessions 为 null（拿不到 /api/agent/sessions/running）时隐藏「分身」统计。

import { THEMES, type CockpitTheme } from '@/components/cabin/cockpit'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitEntry } from '../entry/use-cockpit-entry'
import { useCockpitState } from '../state/CockpitStateProvider'

const THEME_ORDER = Object.keys(THEMES) as CockpitTheme[]

function stat(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

export function CockpitHud() {
  const { prefs, applyPrefs } = useCockpit()
  const { entryCabinId, railOpen, setRailOpen, fx } = useCockpitState()
  const { exitCockpit } = useCockpitEntry()
  const { counts } = useCockpitFleet()

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
      </div>
    </header>
  )
}
