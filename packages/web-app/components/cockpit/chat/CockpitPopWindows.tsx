'use client'

// v20（design 29 §4）：用户自开的作战弹出窗（上限 5，入口只有通讯台 ⧉）。
//
// 每扇窗 = 一个真 ChatPane（绑该线程会话，composer 内联在窗底），不是转录快照：
// 窗内能直接回话，走与主通讯台同一套服务端管线。共享 z 栈（cabin/z-order），
// 聚焦只改 inline z / class，不重建 DOM（重建会吞掉本次 click —— 原型五轮根因）。
// 最小化 → WINDOWS 条 chip 虚线态；关闭 → 线程历史仍在 tab / 面板可回。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, X } from 'lucide-react'
import { ChatPane } from '@/components/agent/chat/ChatPane'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCabinChatWiring } from '@/components/cabin/use-cabin-chat-wiring'
import { nextZ } from '@/components/cabin/z-order'
import { moveCockpitRect, resizeCockpitRect, type Viewport } from './geometry'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitPopWin, CockpitRect } from '../state/cockpit-state'
import { THREAD_EMO } from '../fleet/threads-model'
import { CockpitChoices } from './CockpitChoices'
import { CockpitReceipts } from './CockpitReceipts'
import { useCockpitThreads } from './use-cockpit-threads'

const WIN_LAYER_PRIORITY = 62

function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

interface WinDrag {
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  rect: CockpitRect
}

function CockpitPopWinView({ win }: { win: CockpitPopWin }) {
  const { wins, layer, chatWindow, threads: threadApi } = useCockpitState()
  const { cabinId, cabin } = useCabinContext()
  const { byKey } = useCockpitThreads()
  const thread = byKey.get(win.threadKey)
  const { shared, mainSessionId } = useCabinChatWiring({ sidebarWidth: 0 })

  const [z, setZ] = useState(() => nextZ())
  const bumpZ = useCallback(() => setZ(nextZ()), [])
  const [sessionId, setSessionId] = useState<string | null>(thread?.sessionId ?? null)
  const dragRef = useRef<WinDrag | null>(null)
  const rectRef = useRef(win.rect)
  useEffect(() => { rectRef.current = win.rect }, [win.rect])
  useEffect(() => { setSessionId(thread?.sessionId ?? null) }, [thread?.sessionId])

  useEffect(() => {
    const onFocus = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === win.id) bumpZ()
    }
    window.addEventListener('octopus:cockpit-win-focus', onFocus)
    return () => window.removeEventListener('octopus:cockpit-win-focus', onFocus)
  }, [win.id, bumpZ])

  const close = useCallback(() => wins.closeWindow(win.id), [wins, win.id])
  useEffect(() => {
    if (win.min) return
    return layer.register(`cockpit-win-${win.id}`, WIN_LAYER_PRIORITY, close)
  }, [win.min, win.id, layer, close])

  const beginDrag = useCallback((event: React.PointerEvent<HTMLElement>, mode: WinDrag['mode']) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect: rectRef.current,
    }
  }, [])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = { dx: event.clientX - drag.startX, dy: event.clientY - drag.startY }
    const next = drag.mode === 'move'
      ? moveCockpitRect(drag.rect, delta, viewportSize())
      : resizeCockpitRect(drag.rect, delta, viewportSize())
    wins.patchWindowRect(win.id, next)
  }, [wins, win.id])
  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }, [])

  const backToMain = useCallback(() => {
    threadApi.activateThread('main')
    chatWindow.openWithFocus()
  }, [threadApi, chatWindow])

  if (!thread) return null
  const unread = threadApi.unread[win.threadKey] ?? 0
  const layerRoot = typeof document !== 'undefined'
    ? document.getElementById('ck12-layer-root')
    : null

  return (
    <div
      className={`ck12-cwin${win.min ? ' is-min' : ''}`}
      data-testid={`cockpit-win-${win.id}`}
      data-thread={win.threadKey}
      onPointerDownCapture={bumpZ}
      style={{
        zIndex: z,
        left: win.rect.x,
        top: win.rect.y,
        width: win.rect.w,
        height: win.rect.h,
        display: win.min ? 'none' : undefined,
      }}
    >
      <header
        className="ck12-cwin-head"
        onPointerDown={(event) => beginDrag(event, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="ck12-cwin-emo" aria-hidden="true">{THREAD_EMO[thread.state]}</span>
        <span className="ck12-cwin-title">{thread.title}</span>
        {unread > 0 && <i className="ck12-cwin-unread">{unread > 9 ? '9+' : unread}</i>}
        <button
          type="button"
          className="ck12-cwin-btn"
          aria-label="最小化到 WINDOWS 条"
          title="最小化（WINDOWS 条可恢复）"
          onClick={() => wins.setWindowMin(win.id, true)}
        >
          <Minus className="ck12-cwin-ico" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ck12-cwin-btn ck12-cwin-close"
          aria-label="关闭弹出窗"
          title="关闭（历史保留在 tab）"
          onClick={close}
        >
          <X className="ck12-cwin-ico" aria-hidden="true" />
        </button>
      </header>

      <div className="ck12-cwin-body">
        <ChatPane
          pane="left"
          split={false}
          focused
          secondary={false}
          sessionId={sessionId}
          setSessionId={setSessionId}
          activeTask={null}
          setActiveTask={() => {}}
          pendingTaskSession={null}
          setPendingTaskSession={() => {}}
          command={null}
          layerRoot={layerRoot}
          otherSessionId={null}
          otherTaskId={null}
          onOpenSession={setSessionId}
          shared={shared}
          onFocus={() => {}}
          onStreamingChange={() => {}}
          onOpenSidebar={() => {}}
          onExitSplit={() => {}}
          onSwapPanes={() => {}}
          canSwap={false}
          cabinId={cabinId}
          cabinWorkspaceId={cabin?.workspace_id ?? null}
          cabinMainSessionId={mainSessionId}
          onBackToCabinMain={backToMain}
          composerVariant="cockpit"
          hideDock
        />
        <CockpitReceipts threadKey={win.threadKey} />
      </div>

      <CockpitChoices threadKey={win.threadKey} interactive={false} />

      <div
        className="ck12-cwin-resize"
        role="separator"
        aria-label="缩放弹出窗"
        onPointerDown={(event) => beginDrag(event, 'resize')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}

export function CockpitPopWindows() {
  const { wins } = useCockpitState()
  return (
    <>
      {wins.windows.map((win) => <CockpitPopWinView key={win.id} win={win} />)}
    </>
  )
}
