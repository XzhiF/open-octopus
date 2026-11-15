'use client'

// S5 owns this file —— 底栏 54px 输入区（v13 .cmd .box）。
//
// ticker（S1）与 rig（S6 CockpitBridge）已经由 CockpitShell 作为本组件的
// **兄弟节点**渲染（footer 里的三行），这里**不要**再嵌一遍。
//
// 输入区就是真 composer 的 portal 槽：聚焦/点击 → chatWindow.openWithFocus()
// （v12：底栏随时下指令等于展开对话）；⌘K 同效。无主会话 → 槽里只放禁用文案，
// ChatPane 不挂载（见 CockpitChatHost），所以这里不会出现「发出去却没人接」。
//
// 2026-11-15 v13 · 多行草稿（布局恒定）：
//   · `⇧⏎` / `⌥⏎` 换行 → 编辑器**浮**到底栏上方（fixed），底栏仍是 54px；
//   · 底栏原地只显示首行 + 「▤ N 行」，点底栏把焦点送回同一个 textarea；
//   · `Esc` 收起草稿层（字不丢）；发送后自动收回；
//   · 不改任何 flex 高度 —— 面、ticker、舰桥的 rect 全程不变。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { getChatSlot, setChatSlot, useChatSlot } from './chat-slots'

export interface CockpitCommandBarProps {
  entryCabinId: string
}

interface DraftState {
  on: boolean
  first: string
  lines: number
}

const EMPTY_DRAFT: DraftState = { on: false, first: '', lines: 1 }

function readDraft(node: HTMLElement): DraftState | null {
  const textarea = node.querySelector('textarea')
  if (!textarea) return null
  const value = textarea.value
  const lines = value.split('\n')
  return { on: value.includes('\n'), first: lines[0] ?? '', lines: lines.length }
}

export function CockpitCommandBar({ entryCabinId }: CockpitCommandBarProps) {
  const { cabin } = useCabinContext()
  const { chat, chatWindow, layer } = useCockpitState()
  const composerSlot = useChatSlot('composer')
  const slotRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef<DraftState>(EMPTY_DRAFT)
  const peekTimerRef = useRef<number | null>(null)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const hasMainSession = cabin?.main_session_id != null

  const attachSlot = useCallback((node: HTMLDivElement | null) => {
    slotRef.current = node
    setChatSlot('composer', node)
  }, [])
  useEffect(() => () => {
    setChatSlot('composer', null)
    if (peekTimerRef.current != null) window.clearTimeout(peekTimerRef.current)
  }, [])

  const focusComposer = useCallback(() => {
    chatWindow.openWithFocus()
    // 等 portal 落进槽后再聚焦（槽可能刚被 ChatPane 挂上）。
    requestAnimationFrame(() => {
      const node = getChatSlot('composer') ?? slotRef.current
      node?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    })
  }, [chatWindow])

  // ── 草稿层几何：贴住底栏上沿（fixed，不参与布局）───────────────────
  const placeDraft = useCallback(() => {
    const bar = barRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    bar.style.setProperty('--ck12-draft-x', `${Math.round(rect.left)}px`)
    bar.style.setProperty('--ck12-draft-w', `${Math.round(rect.width)}px`)
    bar.style.setProperty('--ck12-draft-b', `${Math.round(window.innerHeight - rect.top + 8)}px`)
  }, [])

  // 只在「有没有换行」变化时立刻重渲染；草稿态里的首行/行数用 120ms 防抖更新。
  // 每次按键都 setState 会让这个槽在输入事件中途重渲染，实测会吞字。
  const syncDraft = useCallback(() => {
    const node = slotRef.current
    if (!node) return
    const next = readDraft(node)
    if (!next) return
    const current = draftRef.current

    // 单行：不追踪首行（预览用不到），也别重渲染。
    if (!next.on) {
      if (!current.on) {
        draftRef.current = EMPTY_DRAFT
        return
      }
      draftRef.current = EMPTY_DRAFT
      setDraft(EMPTY_DRAFT)
      return
    }

    // 刚出现换行：立刻摊开草稿层。
    if (!current.on) {
      draftRef.current = next
      setDraft(next)
      placeDraft()
      return
    }

    // 已在草稿态：防抖刷新「首行 / N 行」，不跟着每个键重渲染。
    if (peekTimerRef.current != null) return
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null
      const latest = readDraft(node)
      if (!latest || !latest.on) return
      const prev = draftRef.current
      if (prev.first === latest.first && prev.lines === latest.lines) return
      draftRef.current = latest
      setDraft(latest)
    }, 120)
  }, [placeDraft])

  // 注意：composer 是**跨 React 树** portal 进来的（ChatPane 在浮窗里渲染，
  // DOM 落在本槽）。React 的合成事件沿 React 树冒泡，不会经过本组件 ——
  // 所以「聚焦即展开」「多行草稿」都必须挂原生 DOM 监听。
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
      // 草稿态点底栏：把焦点送回浮层里的同一个编辑器。
      if (draftRef.current.on) {
        requestAnimationFrame(() => node.querySelector<HTMLTextAreaElement>('textarea')?.focus())
      }
    }
    node.addEventListener('pointerdown', open)
    node.addEventListener('focusin', open)
    node.addEventListener('input', syncDraft)
    node.addEventListener('keydown', syncDraft)
    return () => {
      node.removeEventListener('pointerdown', open)
      node.removeEventListener('focusin', open)
      node.removeEventListener('input', syncDraft)
      node.removeEventListener('keydown', syncDraft)
    }
  }, [syncDraft])

  // Esc 收起草稿层：注册进唯一的 Esc 栈（最高优先级），字留在 textarea 里。
  // 不能自己挂 capture 监听 —— CockpitLayerStack 在 window 捕获阶段就
  // stopPropagation 了，元素上的监听永远收不到。
  useEffect(() => {
    if (!draft.on) return
    return layer.register('cockpit-draft', 95, () => {
      draftRef.current = { ...draftRef.current, on: false }
      setDraft(draftRef.current)
    })
  }, [draft.on, layer])

  // 发送后（value 被清空）DOM 的 input 事件不会触发 —— Enter 后补拍一次。
  useEffect(() => {
    const node = slotRef.current
    if (!node) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
      window.setTimeout(syncDraft, 0)
    }
    node.addEventListener('keydown', onKeyDown)
    return () => node.removeEventListener('keydown', onKeyDown)
  }, [syncDraft])

  useLayoutEffect(() => {
    if (draft.on) placeDraft()
  }, [draft.on, placeDraft])

  useEffect(() => {
    if (!draft.on) return
    const onResize = () => placeDraft()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draft.on, placeDraft])

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
      ref={barRef}
      className={`ck12-cmdbar${disabled ? ' is-disabled' : ''}${draft.on ? ' is-draft' : ''}`}
      data-testid="cockpit-command-bar"
      data-entry-cabin={entryCabinId}
    >
      <div
        ref={attachSlot}
        className="ck12-cmd-slot"
        data-testid="cockpit-composer-slot"
        data-has-composer={composerSlot ? 'true' : 'false'}
      >
        {draft.on && (
          <span className="ck12-draft-peek" data-testid="cockpit-draft-peek">
            <span className="ck12-draft-first">{draft.first || '（空）'}</span>
            <span className="ck12-draft-lines" data-testid="cockpit-draft-lines">▤ {draft.lines} 行</span>
            <span className="ck12-draft-keys">
              <kbd>⇧⏎</kbd> 换行 · <kbd>⏎</kbd> 发送 · <kbd>Esc</kbd> 收起
            </span>
          </span>
        )}
        {!composerSlot && (
          <span className="ck12-cmd-ph">{placeholder}</span>
        )}
      </div>
    </div>
  )
}