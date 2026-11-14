'use client'

// S5 owns this file —— 浮动对话窗（v12 .comms）。
//
//   position:fixed; z-index:24；默认几何来自 arena + .ck12-scene 的 paddingLeft
//   （plans §0.3），经 chat/geometry 夹回视口；
//   header 灯组在左：✕ → — → 📌（DOM 顺序就是前三颗可聚焦元素），
//   右侧只放拖拽握把与只读读数；右下 18px 缩放；📌 锁拖；— 收起 47px；
//   ◍ 五档 94/82/70/55/100 写 --oa（底板透、字不透）。
//
// **常驻挂载**：✕ 只把 root 切成 display:none，header/body 两个 DOM 节点不动 ——
// body 是 ChatPane transcript 的 portal 挂载点（模块级 chat-slots），节点一换
// ChatPane 就会重挂。composer 已 portal 到底栏，不受隐藏祖先影响，关窗后底栏
// 仍能输入（plans §2.4）。
//
// Esc：由 CockpitLayerStack 统一处理（priority 60 = 作业面之上、其它弹层之下）。
// 流式中先停流（与 composer 内 Esc 同语义），再按一次才收窗。

import { useCallback, useEffect, useRef } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { setChatSlot } from './chat-slots'
import {
  CHAT_MINI_HEIGHT,
  clampCockpitRect,
  cockpitChatPadding,
  cockpitChatRect,
  miniCockpitRect,
  moveCockpitRect,
  nextCockpitAlpha,
  resizeCockpitRect,
  type Viewport,
} from './geometry'
import type { CockpitRect } from '../state/cockpit-state'

/** plans §1.4：popover(100) → 立绘控制条(90) → 任务模块窗(80) → 编队抽屉(70)
 *  → **聊天浮窗(60)** → 作业面(50)。Esc 关栈顶 = 数字大者先关。 */
const CHAT_WINDOW_LAYER_PRIORITY = 60

function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

interface DragState {
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  rect: CockpitRect
}

export function CockpitChatWindow() {
  const { chatWindow, chat, layer } = useCockpitState()
  const {
    open, mini, pinned, alpha, rect,
  } = chatWindow

  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const restoreHeightRef = useRef<number | null>(null)
  const userAdjustedRef = useRef(false)
  const rectRef = useRef<CockpitRect | null>(rect)
  const setRef = useRef(chatWindow.set)
  const chatRef = useRef(chat)

  useEffect(() => {
    rectRef.current = rect
    setRef.current = chatWindow.set
    chatRef.current = chat
  })

  const attachTranscript = useCallback((node: HTMLDivElement | null) => {
    setChatSlot('transcript', node)
  }, [])
  useEffect(() => () => setChatSlot('transcript', null), [])

  const computeDefaultRect = useCallback((): CockpitRect | null => {
    const arena = document.getElementById('ck12-arena')
    if (!arena) return null
    const box = arena.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) return null
    // S4 的 .ck12-scene 还没有落地时退回断点值（366 / 334 / 300）。
    const scene = arena.querySelector<HTMLElement>('.ck12-scene')
    const scenePad = scene ? Number.parseFloat(getComputedStyle(scene).paddingLeft) : Number.NaN
    const pad = Number.isFinite(scenePad) && scenePad > 0
      ? scenePad
      : cockpitChatPadding(window.innerWidth)
    return clampCockpitRect(cockpitChatRect(box, pad), viewportSize())
  }, [])

  // 第一次开窗：量 arena 落默认几何；之后只在用户没动过时跟随布局（rAF 让
  // footer/ticker 的高度先落定，避免用上一帧的 arena 量出短一截的窗）。
  useEffect(() => {
    if (!open || rect) return
    const raf = requestAnimationFrame(() => {
      const next = computeDefaultRect()
      if (next) setRef.current({ rect: next })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, rect, computeDefaultRect])

  // ticker/rig 收起或视口变化后补满：用户没手动拖过才重算，否则只夹回。
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      const current = rectRef.current
      if (!current) return
      if (!userAdjustedRef.current) {
        const next = computeDefaultRect()
        if (next) setRef.current({ rect: next })
        return
      }
      setRef.current({ rect: clampCockpitRect(current, viewportSize()) })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, computeDefaultRect])

  useEffect(() => {
    if (!open) return
    const onResize = () => {
      const current = rectRef.current
      if (!current) return
      if (!userAdjustedRef.current) {
        const next = computeDefaultRect()
        if (next) {
          setRef.current({ rect: next })
          return
        }
      }
      setRef.current({ rect: clampCockpitRect(current, viewportSize()) })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, computeDefaultRect])

  // Esc 栈：流式中先停流，再按一次才收窗。
  const closeLayer = useCallback(() => {
    const current = chatRef.current
    if (current?.streaming) {
      current.stop()
      return
    }
    setRef.current({ open: false })
  }, [])
  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-chat-window', CHAT_WINDOW_LAYER_PRIORITY, closeLayer)
  }, [open, layer, closeLayer])

  // ── 拖拽 / 缩放（pointer capture）────────────────────────────────────
  const beginDrag = useCallback((event: React.PointerEvent<HTMLElement>, mode: DragState['mode']) => {
    const current = rectRef.current
    if (!current) return
    if (pinned) return
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: current,
    }
  }, [pinned])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    userAdjustedRef.current = true
    const delta = { dx: event.clientX - drag.startX, dy: event.clientY - drag.startY }
    const next = drag.mode === 'move'
      ? moveCockpitRect(drag.rect, delta, viewportSize())
      : resizeCockpitRect(drag.rect, delta, viewportSize())
    setRef.current({ rect: next })
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }, [])

  const toggleMini = useCallback(() => {
    const current = rectRef.current
    if (!current) {
      setRef.current({ mini: !mini })
      return
    }
    if (!mini) {
      restoreHeightRef.current = current.h
      setRef.current({ mini: true, rect: miniCockpitRect(current) })
      return
    }
    const restored = restoreHeightRef.current ?? Math.max(CHAT_MINI_HEIGHT, current.h)
    setRef.current({
      mini: false,
      rect: clampCockpitRect({ ...current, h: restored }, viewportSize()),
    })
  }, [mini])

  const bodyVisible = open && !mini
  const statusText = !chat
    ? '未就绪'
    : chat.streaming
      ? '流式中'
      : chat.queueDepth > 0
        ? `排队 ${chat.queueDepth}`
        : '待命'

  return (
    <div
      ref={rootRef}
      className={`ck12-comms${mini ? ' is-mini' : ''}${pinned ? ' is-pinned' : ''}`}
      data-testid="cockpit-chat-window"
      data-open={open ? 'true' : 'false'}
      data-mini={mini ? 'true' : 'false'}
      style={{
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.w ?? 0,
        height: rect?.h ?? 0,
        display: open ? undefined : 'none',
        // 底板透、字不透：--oa 只喂背景/边框，正文用 1 号不透明度。
        ['--oa' as string]: String(alpha),
      }}
    >
      <header
        className="ck12-comms-head"
        onPointerDown={(event) => beginDrag(event, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="ck12-comms-lights">
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-close"
            aria-label="关闭对话窗"
            title="关闭（Esc）"
            onClick={() => setRef.current({ open: false })}
          >
            ✕
          </button>
          <button
            type="button"
            className="ck12-comms-btn"
            aria-label={mini ? '展开对话窗' : '收起对话窗'}
            aria-pressed={mini}
            title={mini ? '展开（47px）' : '收起（47px）'}
            onClick={toggleMini}
          >
            —
          </button>
          <button
            type="button"
            className="ck12-comms-btn"
            aria-label="锁定位置"
            aria-pressed={pinned}
            title={pinned ? '解除锁定' : '锁定位置与大小'}
            onClick={() => setRef.current({ pinned: !pinned })}
          >
            📌
          </button>
        </div>

        <span className="ck12-comms-title">汐音 · 对话</span>
        <span className="ck12-comms-status" data-state={chat?.streaming ? 'streaming' : 'idle'}>
          {statusText}
        </span>
        <span className="ck12-comms-grip" aria-hidden="true">⠿</span>
        <button
          type="button"
          className="ck12-comms-alpha"
          aria-label="调整不透明度"
          title={`不透明度 ${Math.round(alpha * 100)}%`}
          onClick={() => setRef.current({ alpha: nextCockpitAlpha(alpha) })}
        >
          ◍ {Math.round(alpha * 100)}
        </button>
      </header>

      {/* 常驻节点：关窗/收起只隐藏，不卸载 —— ChatPane 的 transcript portal 目标。 */}
      <div
        ref={attachTranscript}
        className="ck12-comms-body"
        data-testid="cockpit-chat-transcript"
        style={{ display: bodyVisible ? undefined : 'none' }}
      />

      <div
        className="ck12-comms-resize"
        role="separator"
        aria-label="缩放对话窗"
        onPointerDown={(event) => beginDrag(event, 'resize')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}
