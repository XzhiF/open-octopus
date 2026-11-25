'use client'

// S9 owns this file —— 全域座舱键盘（只在 CockpitShell 里挂一处）。
//
//   ⌥1  最紧要的一条（need 优先级降序 → run → queue）
//   ⌥2  收面（select(null)）
//   ⌘K  打开聊天浮窗并聚焦真 composer（输入框里也生效 —— 唯一例外）
//   ⌥W  跃迁特效 + 切下一幕舱景（travel）
//   ⌥D  本舱主会话调试面
//   ⌥F  打开 / 收起本舱目录窗（当前 cwd 只读树）
//   ⌥X  打开 / 收起汐音设置（HUD「◐ 汐音」同一个开关）
//   ⌥A  开合通讯台标题栏「星核」挂载面板（技能 / 分身 / MCP）
//   ⌥G  打开 / 收起本舱变更窗（cwd 工作区改动；仅 cwd 是独立 git 仓库时生效）
//   ⌥V  开合右栏「活动」（有运行中的子代理 / 后台作业时才有按钮）
//   ↑↓  不在这里 —— S3 的 CockpitFleetRail 已在可见行内处理。
//
// 约定（与仓库桌面快捷键一致）：
//   · 先过 useIsActiveRoute：隐藏窗口 / 后台标签不抢键；
//   · 输入框 / textarea / select / contenteditable 聚焦时不抢键（⌘K / ⌥A 除外）；
//   · macOS 上 Alt+字母会得到特殊字符（Alt+W = ∑），所以优先看 event.code。

import { useEffect, useRef } from 'react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { getChatSlot } from '../chat/chat-slots'
import { toggleCrewSettings } from '../crew/crew-settings'
import { toggleCabinTree } from '../face/cabin-tree-store'
import { toggleChanges } from '../face/changes-store'
import { candidatesOf } from './cockpit-candidates'
import { resolveDefaultRef } from './cockpit-url'
import { useOptionalIsActiveRoute } from './safe-navigation'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/** Alt + 哪个键（不认识返回 null）。兼容 event.code 缺失的合成事件与测试。 */
function altKeyOf(event: KeyboardEvent): '1' | '2' | 'w' | 'x' | 'c' | 'd' | 'f' | 'g' | 'v' | 'a' | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null
  if (event.code === 'Digit1' || event.code === 'Numpad1' || event.key === '1') return '1'
  if (event.code === 'Digit2' || event.code === 'Numpad2' || event.key === '2') return '2'
  if (event.code === 'KeyW' || event.key.toLowerCase() === 'w') return 'w'
  if (event.code === 'KeyX' || event.key.toLowerCase() === 'x') return 'x'
  if (event.code === 'KeyC' || event.key.toLowerCase() === 'c') return 'c'
  if (event.code === 'KeyD' || event.key.toLowerCase() === 'd') return 'd'
  if (event.code === 'KeyF' || event.key.toLowerCase() === 'f') return 'f'
  if (event.code === 'KeyG' || event.key.toLowerCase() === 'g') return 'g'
  if (event.code === 'KeyV' || event.key.toLowerCase() === 'v') return 'v'
  if (event.code === 'KeyA' || event.key.toLowerCase() === 'a') return 'a'
  return null
}

function isCommandK(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
  return event.code === 'KeyK' || event.key.toLowerCase() === 'k'
}

export function CockpitShortcuts() {
  const active = useOptionalIsActiveRoute()
  const { rows } = useCockpitFleet()
  const { select, chatWindow, openPanel, travel } = useCockpitState()
  const cabin = useCabinOptional()?.cabin

  // 监听只挂一次（active 变化时重挂）；其余可变值走 ref，避免每 10s 轮询
  // 都重装一次 window 监听。
  const rowsRef = useRef(rows)
  const selectRef = useRef(select)
  const openRef = useRef(chatWindow.openWithFocus)
  const jumpRef = useRef(travel)
  const cwRef = useRef(chatWindow)
  const panelRef = useRef(openPanel)
  /** ⌥G 只在本舱 cwd 是独立 git 仓库时生效 —— 与右栏「变更」按钮同一出现条件。 */
  const cwdGitRef = useRef(false)
  rowsRef.current = rows
  selectRef.current = select
  openRef.current = chatWindow.openWithFocus
  jumpRef.current = travel
  cwRef.current = chatWindow
  panelRef.current = openPanel
  cwdGitRef.current = cabin?.cwd_git === true

  useEffect(() => {
    if (!active) return
    if (typeof window === 'undefined') return

    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K 是唯一在输入框里也生效的键：聚焦 composer 并开窗。
      if (isCommandK(event)) {
        event.preventDefault()
        openRef.current()
        requestAnimationFrame(() => {
          getChatSlot('composer')
            ?.querySelector<HTMLTextAreaElement>('textarea')
            ?.focus()
        })
        return
      }

      if (isEditableTarget(event.target)) {
        // ⌥A 是唯一的例外（原型口径：面板搜索框里再按一次也能收起）；
        // Alt+A 不是打字键，AltGr 组合（带 ctrl）已在 altKeyOf 里排除。
        if (altKeyOf(event) === 'a') {
          event.preventDefault()
          window.dispatchEvent(new Event('octopus:composer-attach'))
        }
        return
      }

      const key = altKeyOf(event)
      if (!key) return

      if (key === '1') {
        const ref = resolveDefaultRef(candidatesOf(rowsRef.current))
        if (!ref) return
        event.preventDefault()
        selectRef.current(ref)
        return
      }

      if (key === '2') {
        event.preventDefault()
        selectRef.current(null)
        return
      }

      if (key === 'w') {
        event.preventDefault()
        jumpRef.current()
        return
      }

      if (key === 'x') {
        event.preventDefault()
        toggleCrewSettings()
        return
      }

      // v20（design 29 §10）：⌥C 收起/展开停靠 · ⌥D 本舱主会话调试 · ⌥←/→ 切 tab。
      if (key === 'c') {
        event.preventDefault()
        const cw = cwRef.current
        if (cw.docked) cw.openWithFocus()
        else cw.set({ docked: true })
        return
      }

      if (key === 'd') {
        event.preventDefault()
        panelRef.current('debug')
        return
      }

      // v22 九轮：⌥F 打开 / 收起本舱目录窗（当前 cwd 只读树）。
      if (key === 'f') {
        event.preventDefault()
        toggleCabinTree()
        return
      }

      // v22 十三轮（问题 #1）：⌥G 打开 / 收起本舱变更窗（cwd 工作区改动）。
      // 出现条件同右栏按钮：cwd 本身不是独立 git 仓库 → 不抢这个键。
      if (key === 'g') {
        if (!cwdGitRef.current) return
        event.preventDefault()
        toggleChanges()
        return
      }

      // v22 十四轮：⌥V 开合右栏「活动」。按钮常住（无运行中活动时点开是空态），
      // 窄屏（≤900）按钮退场 —— 这里点不到就什么也不做。
      if (key === 'v') {
        if (window.innerWidth <= 900) return
        const button = document.querySelector<HTMLButtonElement>('[data-testid="cockpit-menu-activity"]')
        if (!button) return
        event.preventDefault()
        button.click()
        return
      }

      // v22 十轮：⌥A 开合通讯台「星核」挂载面板（面板本体在 ChatArea）。
      if (key === 'a') {
        event.preventDefault()
        window.dispatchEvent(new Event('octopus:composer-attach'))
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])

  return null
}
