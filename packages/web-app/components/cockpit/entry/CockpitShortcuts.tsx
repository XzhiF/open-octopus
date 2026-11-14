'use client'

// S9 owns this file —— 全域座舱键盘（只在 CockpitShell 里挂一处）。
//
//   ⌥1  最紧要的一条（need 优先级降序 → run → queue）
//   ⌥2  收面（select(null)）
//   ⌘K  打开聊天浮窗并聚焦真 composer（输入框里也生效 —— 唯一例外）
//   ⌥W  跃迁特效（fx.jump）
//   ⌥G  不处理：全域入口是 classic 舱壳上的按钮（单向切换），这里没有对应动作。
//   ↑↓  不在这里 —— S3 的 CockpitFleetRail 已在可见行内处理。
//
// 约定（与仓库桌面快捷键一致）：
//   · 先过 useIsActiveRoute：隐藏窗口 / 后台标签不抢键；
//   · 输入框 / textarea / select / contenteditable 聚焦时不抢键（⌘K 除外）；
//   · macOS 上 Alt+字母会得到特殊字符（Alt+W = ∑），所以优先看 event.code。

import { useEffect, useRef } from 'react'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { getChatSlot } from '../chat/chat-slots'
import { candidatesOf } from './cockpit-candidates'
import { resolveDefaultRef } from './cockpit-url'
import { useOptionalIsActiveRoute } from './safe-navigation'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/** Alt + 哪个键（不认识返回 null）。兼容 event.code 缺失的合成事件与测试。 */
function altKeyOf(event: KeyboardEvent): '1' | '2' | 'w' | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null
  if (event.code === 'Digit1' || event.code === 'Numpad1' || event.key === '1') return '1'
  if (event.code === 'Digit2' || event.code === 'Numpad2' || event.key === '2') return '2'
  if (event.code === 'KeyW' || event.key.toLowerCase() === 'w') return 'w'
  return null
}

function isCommandK(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
  return event.code === 'KeyK' || event.key.toLowerCase() === 'k'
}

export function CockpitShortcuts() {
  const active = useOptionalIsActiveRoute()
  const { rows } = useCockpitFleet()
  const { select, chatWindow, fx } = useCockpitState()

  // 监听只挂一次（active 变化时重挂）；其余可变值走 ref，避免每 10s 轮询
  // 都重装一次 window 监听。
  const rowsRef = useRef(rows)
  const selectRef = useRef(select)
  const openRef = useRef(chatWindow.openWithFocus)
  const jumpRef = useRef(fx.jump)
  rowsRef.current = rows
  selectRef.current = select
  openRef.current = chatWindow.openWithFocus
  jumpRef.current = fx.jump

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

      if (isEditableTarget(event.target)) return

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
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])

  return null
}
