'use client'

// v21 二轮（原型 .rmenu / .fanwrap）· 右栏主按钮组：
//   下指令（big）→ 目录 → 消耗 → 调试 → 更多。
// v22 九轮：「目录」取代原位的「跃迁」，打开本舱 cwd 只读目录窗（⌥F）；
//   跃迁挪进「更多」（⌥W / 点顶部场景名仍可跃迁）。
// 「更多」= **纯点击开合**（再点收回；点外面也收），向左横排展开 7 项
// （汐音 / 动作 / 日志 / 跃迁 / 模拟 / 设置 / 编队）。不再用悬停开合。
//
// 动作全部复用既有入口（不新造面板）：账本 = ledger 面板、调试 = 本舱主会话
// debug 面板（不是某条作业）、目录 = 本舱 cwd 只读窗、动作 = poses 面板、
// 设置 = CockpitSettings 弹窗。作业自身的调试在作业面「调试」页签。

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { toggleCrewSettings } from '../crew/crew-settings'
import { toggleCabinTree } from '../face/cabin-tree-store'
import { useCockpitState } from '../state/CockpitStateProvider'
import { setCockpitSettingsOpen } from '../shell/settings-store'

const FAN_ITEMS = [
  { id: 'xiyin', glyph: '♡', label: '汐音' },
  { id: 'poses', glyph: '✧', label: '动作' },
  { id: 'log', glyph: '≡', label: '日志' },
  { id: 'warp', glyph: '⟳', label: '跃迁' },
  { id: 'sim', glyph: '✦', label: '模拟' },
  { id: 'settings', glyph: '⚙', label: '设置' },
  { id: 'fleet', glyph: '⬡', label: '编队' },
] as const

export function CockpitMenuRail() {
  const {
    chatWindow, openPanel, setRailOpen, travel,
  } = useCockpitState()
  const [fanOpen, setFanOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // 点击外面收起（原型 pointerdown 监听）。
  useEffect(() => {
    if (!fanOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && wrapRef.current?.contains(target)) return
      setFanOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [fanOpen])

  /** 调试目标 = 本舱主会话（跟汐音的主 chat）。作业调试走它自己的详情页签。 */
  const openDebug = useCallback(() => openPanel('debug'), [openPanel])

  const fanAction = useCallback((id: string) => {
    setFanOpen(false)
    switch (id) {
      case 'xiyin': toggleCrewSettings(); break
      case 'poses': openPanel('poses'); break
      case 'log':
        chatWindow.openWithFocus()
        window.dispatchEvent(new CustomEvent('octopus:chat-tall'))
        break
      case 'warp': travel(); break
      case 'sim':
        if (import.meta.env.DEV) {
          window.dispatchEvent(new CustomEvent('octopus:demo-arrival'))
          toast('演示回流已发出（仅 DEV）')
        } else {
          toast('模拟回流仅在开发模式可用')
        }
        break
      case 'settings': setCockpitSettingsOpen(true); break
      case 'fleet': setRailOpen(true); break
      default: break
    }
  }, [chatWindow, openPanel, setRailOpen, travel])

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
        className="ck12-rhex"
        title="本舱目录 · 当前 cwd 目录树（⌥F，只读）"
        data-testid="cockpit-menu-cabin-tree"
        onClick={() => toggleCabinTree()}
      >
        <span className="ck12-rhex-i" aria-hidden="true">⌗</span>
        <span className="ck12-rhex-l">目录</span>
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="本舱账本（全域累计 · 只读）"
        data-testid="cockpit-menu-usage"
        onClick={() => openPanel('ledger')}
      >
        <span className="ck12-rhex-i" aria-hidden="true">¥</span>
        <span className="ck12-rhex-l">消耗</span>
      </button>

      <button
        type="button"
        className="ck12-rhex"
        title="调试 inspect · 本舱主会话（常驻 · ⌥D）"
        data-testid="cockpit-menu-debug"
        onClick={openDebug}
      >
        <span className="ck12-rhex-i" aria-hidden="true">⚙</span>
        <span className="ck12-rhex-l">调试</span>
      </button>

      <div className="ck12-morewrap" ref={wrapRef}>
        <button
          type="button"
          className={`ck12-rhex is-more${fanOpen ? ' is-on' : ''}`}
          title="更多 · 点击展开 / 再点收回"
          aria-expanded={fanOpen}
          data-testid="cockpit-menu-more"
          onClick={(event) => {
            event.stopPropagation()
            setFanOpen((open) => !open)
          }}
        >
          <span className="ck12-rhex-i" aria-hidden="true">⋯</span>
          <span className="ck12-rhex-l">更多</span>
        </button>

        <div
          className={`ck12-fanwrap${fanOpen ? ' is-on' : ''}`}
          data-testid="cockpit-menu-fan"
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
