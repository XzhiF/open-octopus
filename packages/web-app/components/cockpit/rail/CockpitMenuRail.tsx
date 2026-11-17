'use client'

// v21（design 31 §3.3）· 右栏主按钮组：下指令（big）→ 跃迁 → 消耗 → 调试 → 更多。
// 消耗 / 调试常驻；「更多」悬停或点击向左横排展开 7 项（汐音 / 动作 / 日志 / 文件 /
// 模拟 / 换色 / 编队），stagger 24ms，离开 240ms 收起。
//
// 动作全部复用既有入口（不新造面板）：账本 = ledger 面板、调试 = 当前线程作业面
// debug 页签、文件 = ws 面板、动作 = poses 面板。

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { THEMES, type CockpitTheme } from '@/components/cabin/cockpit'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { toggleCrewSettings } from '../crew/crew-settings'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitThreads } from '../chat/use-cockpit-threads'
import type { CockpitRef } from '../state/cockpit-state'

const THEME_ORDER = Object.keys(THEMES) as CockpitTheme[]

const FAN_ITEMS = [
  { id: 'xiyin', glyph: '♡', label: '汐音' },
  { id: 'poses', glyph: '✧', label: '动作' },
  { id: 'log', glyph: '≡', label: '日志' },
  { id: 'files', glyph: '⌗', label: '文件' },
  { id: 'sim', glyph: '✦', label: '模拟' },
  { id: 'theme', glyph: '◐', label: '换色' },
  { id: 'fleet', glyph: '⬡', label: '编队' },
] as const

export function CockpitMenuRail() {
  const {
    chatWindow, openPanel, select, selection, setRailOpen, fx, travel,
  } = useCockpitState()
  const { rows } = useCockpitFleet()
  const { active } = useCockpitThreads()
  const { prefs, applyPrefs } = useCockpit()
  const [fanOpen, setFanOpen] = useState(false)
  const fanTimerRef = useRef<number | null>(null)

  const openFan = useCallback(() => {
    if (fanTimerRef.current !== null) window.clearTimeout(fanTimerRef.current)
    setFanOpen(true)
  }, [])
  const closeFanSoon = useCallback(() => {
    if (fanTimerRef.current !== null) window.clearTimeout(fanTimerRef.current)
    fanTimerRef.current = window.setTimeout(() => setFanOpen(false), 240)
  }, [])
  useEffect(() => () => {
    if (fanTimerRef.current !== null) window.clearTimeout(fanTimerRef.current)
  }, [])

  /** 调试目标：当前线程的作业 → 当前选中 → 编队第一条有 ref 的行。 */
  const debugTarget = useCallback((): CockpitRef | null => {
    if (active.ref) return active.ref
    if (selection) return selection
    for (const row of rows) {
      if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
      if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
    }
    return null
  }, [active.ref, selection, rows])

  const cycleTheme = useCallback(() => {
    const index = THEME_ORDER.indexOf(prefs.theme)
    applyPrefs({ ...prefs, theme: THEME_ORDER[(index + 1) % THEME_ORDER.length] })
    fx.jump()
  }, [applyPrefs, fx, prefs])

  const fanAction = useCallback((id: string) => {
    setFanOpen(false)
    switch (id) {
      case 'xiyin': toggleCrewSettings(); break
      case 'poses': openPanel('poses'); break
      case 'log':
        chatWindow.openWithFocus()
        window.dispatchEvent(new CustomEvent('octopus:chat-tall'))
        break
      case 'files': openPanel('ws'); break
      case 'sim':
        if (import.meta.env.DEV) {
          window.dispatchEvent(new CustomEvent('octopus:demo-arrival'))
          toast('演示回流已发出（仅 DEV）')
        } else {
          toast('模拟回流仅在开发模式可用')
        }
        break
      case 'theme': cycleTheme(); break
      case 'fleet': setRailOpen(true); break
      default: break
    }
  }, [chatWindow, cycleTheme, openPanel, setRailOpen])

  const openCommand = useCallback(() => {
    chatWindow.openWithFocus()
    // 与 ⌘K 同义：展开后把焦点送进 composer（portal 槽可能在下一帧才落）。
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="cockpit-composer-slot"] textarea')
        ?.focus()
    })
  }, [chatWindow])

  return (
    <nav className="ck12-rmenu" aria-label="主菜单" data-testid="cockpit-menu-rail">
      <button
        type="button"
        className="ck12-rhex is-big"
        title="下指令 · 回主对话（⌘K）"
        data-testid="cockpit-menu-command"
        onClick={openCommand}
      >
        <span className="ck12-rhex-i" aria-hidden="true">❯</span>
        <span className="ck12-rhex-l">下指令</span>
      </button>

      <button
        type="button"
        className="ck12-rhex is-warp"
        title="跃迁 · 星穿梭切下一幕（⌥W）"
        data-testid="cockpit-menu-warp"
        onClick={() => travel()}
      >
        <span className="ck12-rhex-i" aria-hidden="true">⟳</span>
        <span className="ck12-rhex-l">跃迁</span>
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="消耗账本（常驻）"
        data-testid="cockpit-menu-usage"
        onClick={() => openPanel('ledger')}
      >
        <span className="ck12-rhex-i" aria-hidden="true">¥</span>
        <span className="ck12-rhex-l">消耗</span>
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="调试 inspect（常驻 · ⌥D）"
        data-testid="cockpit-menu-debug"
        onClick={() => {
          const ref = debugTarget()
          if (!ref) { toast('编队里还没有可调试的作业'); return }
          select(ref, 'debug')
        }}
      >
        <span className="ck12-rhex-i" aria-hidden="true">⚙</span>
        <span className="ck12-rhex-l">调试</span>
      </button>

      <div
        className="ck12-morewrap"
        onPointerEnter={openFan}
        onPointerLeave={closeFanSoon}
      >
        <button
          type="button"
          className={`ck12-rhex is-more${fanOpen ? ' is-on' : ''}`}
          title="更多 · 悬停向左横排展开"
          aria-expanded={fanOpen}
          data-testid="cockpit-menu-more"
          onClick={(event) => {
            event.stopPropagation()
            // 指针悬停已经打开过一次；再点一下不能把它关掉（Playwright /
            // 真实鼠标都是 hover→click，旧版 toggle 会让「点击展开」变成
            // 展开后立即收起）。收起只走 pointerleave。
            openFan()
          }}
        >
          <span className="ck12-rhex-i" aria-hidden="true">⋯</span>
          <span className="ck12-rhex-l">更多</span>
        </button>

        <div
          className={`ck12-fanwrap${fanOpen ? ' is-on' : ''}`}
          data-testid="cockpit-menu-fan"
          onPointerEnter={openFan}
        >
          <span className="ck12-fanlead">MORE</span>
          <div className="ck12-fan">
            {FAN_ITEMS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="ck12-fitem"
                style={{ ['--d' as string]: `${index * 24}ms` }}
                data-testid={`cockpit-fan-${item.id}`}
                onClick={() => fanAction(item.id)}
              >
                <span className="ck12-fitem-h" aria-hidden="true">{item.glyph}</span>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
}
