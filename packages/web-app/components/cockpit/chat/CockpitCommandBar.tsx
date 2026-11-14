'use client'

// S5 owns this file —— 底栏 54px 输入区（v12 .cmd .box）。
//
// ticker（S1）与 rig（S6 CockpitBridge）已经由 CockpitShell 作为本组件的
// **兄弟节点**渲染（footer 里的三行），这里**不要**再嵌一遍。
//
// 输入区就是真 composer 的 portal 槽：聚焦/点击 → chatWindow.openWithFocus()
// （v12：底栏随时下指令等于展开对话）；⌘K 同效。无主会话 → 槽里只放禁用文案，
// ChatPane 不挂载（见 CockpitChatHost），所以这里不会出现「发出去却没人接」。

import { useCallback, useEffect, useRef } from 'react'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { getChatSlot, setChatSlot, useChatSlot } from './chat-slots'

export interface CockpitCommandBarProps {
  entryCabinId: string
}

export function CockpitCommandBar({ entryCabinId }: CockpitCommandBarProps) {
  const { cabin } = useCabinContext()
  const { chat, chatWindow } = useCockpitState()
  const composerSlot = useChatSlot('composer')
  const slotRef = useRef<HTMLDivElement | null>(null)
  const hasMainSession = cabin?.main_session_id != null

  const attachSlot = useCallback((node: HTMLDivElement | null) => {
    slotRef.current = node
    setChatSlot('composer', node)
  }, [])
  useEffect(() => () => setChatSlot('composer', null), [])

  const focusComposer = useCallback(() => {
    chatWindow.openWithFocus()
    // 等 portal 落进槽后再聚焦（槽可能刚被 ChatPane 挂上）。
    requestAnimationFrame(() => {
      const node = getChatSlot('composer') ?? slotRef.current
      node?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    })
  }, [chatWindow])

  // 注意：composer 是**跨 React 树** portal 进来的（ChatPane 在浮窗里渲染，
  // DOM 落在本槽）。React 的合成事件沿 React 树冒泡，不会经过本组件 ——
  // 所以「聚焦即展开」必须挂原生 DOM 监听，pointerdown / focusin 都按 DOM 树走。
  const openRef = useRef(chatWindow.openWithFocus)
  const disabledRef = useRef(!hasMainSession)
  useEffect(() => {
    openRef.current = chatWindow.openWithFocus
    disabledRef.current = !hasMainSession
  })
  useEffect(() => {
    const node = slotRef.current
    if (!node) return
    const open = () => {
      if (disabledRef.current) return
      openRef.current()
    }
    node.addEventListener('pointerdown', open)
    node.addEventListener('focusin', open)
    return () => {
      node.removeEventListener('pointerdown', open)
      node.removeEventListener('focusin', open)
    }
  }, [])

  // ⌘K / Ctrl+K：与点输入区同效。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      focusComposer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusComposer])

  const disabled = !hasMainSession
  const placeholder = disabled
    ? '该舱还没有主会话 · 聊天暂不可用'
    : chat === null
      ? '正在接上汐音…'
      : '下指令，或者描述要开发的事…（⌘K）'

  return (
    <div
      className={`ck12-cmdbar${disabled ? ' is-disabled' : ''}`}
      data-testid="cockpit-command-bar"
      data-entry-cabin={entryCabinId}
    >
      <div
        ref={attachSlot}
        className="ck12-cmd-slot"
        data-testid="cockpit-composer-slot"
        data-has-composer={composerSlot ? 'true' : 'false'}
      >
        {!composerSlot && (
          <span className="ck12-cmd-ph">{placeholder}</span>
        )}
      </div>
    </div>
  )
}
