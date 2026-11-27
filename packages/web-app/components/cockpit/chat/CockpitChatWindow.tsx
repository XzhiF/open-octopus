'use client'

// S5 owns this file —— 浮动对话窗（v12 .comms → v20 通讯台）。
//
//   position:fixed；默认几何来自 arena + .ck12-scene 的 paddingLeft（plans §0.3），
//   经 chat/geometry 夹回视口；header 灯组在左：关闭 / 收起 / 锁定（X / Minus / Pin
//   图标，DOM 顺序就是前三颗可聚焦元素），右侧只放拖拽握把与只读读数；右下 18px
//   缩放；锁定后拖不动；收起成 47px；◍ 五档 94/82/70/55/100 写 --oa。
//
// v22 #5（2026-11-23 用户）：**主通讯台固定回汐音主对话** —— 线程切换整套撤掉
//   （← 主对话 / ⚙ 调试 / ▦ 详情 / ⧉ 弹出 / 作业线程标题）。编队对话是独立 chat
//   窗（CockpitPopWindows），详情是 dossier。主台只留：✕ 收起 / 星核挂载 /
//   遥测 / 对话索引 / ⌄ 停靠。
//
// **常驻挂载**：关闭只把 root 切成 display:none，header/body 两个 DOM 节点不动 ——
// body 是 ChatPane transcript 的 portal 挂载点（模块级 chat-slots），节点一换
// ChatPane 就会重挂。v21 三轮：composer 也 portal 进台内输入行（原型 .con-in），
// 关窗即整台停靠，输入随台一起隐藏（点 dock pill 展开）。
//
// Esc：由 CockpitLayerStack 统一处理（priority 60 = 作业面之上、其它弹层之下）。
// 流式中先停流（与 composer 内 Esc 同语义），再按一次才收窗。

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { nextZ } from '@/components/cabin/z-order'
import { setChatSlot, useChatSlot } from './chat-slots'
import {
  clampCockpitRect,
  cockpitConsoleRect,
  moveCockpitRect,
  resizeCockpitRect,
  resizeCockpitRectLeft,
  resizeCockpitRectTop,
  type Viewport,
} from './geometry'
import type { CockpitRect } from '../state/cockpit-state'
import { MAIN_THREAD_KEY } from '../fleet/threads-model'
import { CockpitConsoleTelemetry } from './CockpitConsoleTelemetry'
import { CockpitReceipts } from './CockpitReceipts'
import { CockpitItemsQueue } from '../items/CockpitItemsQueue'
import { setActiveWin } from './active-win'
import { toggleCrewSettings } from '../crew/crew-settings'

/** plans §1.4：popover(100) → 立绘控制条(90) → 任务模块窗(80) → 编队抽屉(70)
 *  → **聊天浮窗(60)** → 作业面(50)。Esc 关栈顶 = 数字大者先关。 */
const CHAT_WINDOW_LAYER_PRIORITY = 60

function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

interface DragState {
  mode: 'move' | 'resize' | 'resize-l' | 'resize-t'
  pointerId: number
  startX: number
  startY: number
  rect: CockpitRect
}

export function CockpitChatWindow() {
  const { chatWindow, chat, layer } = useCockpitState()
  const {
    open, mini, pinned, alpha, rect, docked,
  } = chatWindow

  const rootRef = useRef<HTMLDivElement>(null)
  /** 共享 z 栈（design 26 §5.3）：打开 / 聚焦即置顶，问答窗反而能再压回来。 */
  const [z, setZ] = useState<number | null>(null)
  const bumpZ = useCallback(() => setZ(nextZ()), [])
  /** 点主通讯台 = 它压在最上；独立窗的焦点环随之熄灭（v22 · 2026-11-27）。 */
  const raiseConsole = useCallback(() => {
    bumpZ()
    setActiveWin(null)
  }, [bumpZ])
  const dragRef = useRef<DragState | null>(null)
  const tallRestoreRef = useRef<CockpitRect | null>(null)
  const userAdjustedRef = useRef(false)
  const rectRef = useRef<CockpitRect | null>(rect)
  const setRef = useRef(chatWindow.set)
  const chatRef = useRef(chat)

  useEffect(() => {
    rectRef.current = rect
    setRef.current = chatWindow.set
    chatRef.current = chat
  })

  // 打开、或从任意入口再次聚焦（openWithFocus 发 octopus:chat-focus）都置顶。
  useEffect(() => {
    if (open && !docked) bumpZ()
  }, [open, docked, bumpZ])
  useEffect(() => {
    window.addEventListener('octopus:chat-focus', raiseConsole)
    return () => window.removeEventListener('octopus:chat-focus', raiseConsole)
  }, [raiseConsole])

  const attachTranscript = useCallback((node: HTMLDivElement | null) => {
    setChatSlot('transcript', node)
  }, [])
  useEffect(() => () => setChatSlot('transcript', null), [])

  // v21 三轮：输入框回到通讯台里（原型 .con-in）—— 底栏不再常驻。
  // 槽节点常驻（关窗只 display:none），ChatPane 的 composer portal 不重挂。
  const attachComposer = useCallback((node: HTMLDivElement | null) => {
    setChatSlot('composer', node)
  }, [])
  useEffect(() => () => setChatSlot('composer', null), [])
  const composerSlot = useChatSlot('composer')

  // 标题栏「对话索引」挂载点：ChatTimeline（compact）portal 进来。
  // 正文右侧不再有任何常驻控件 —— 索引只存在于窗框里。
  const attachIndex = useCallback((node: HTMLSpanElement | null) => {
    setChatSlot('index', node)
  }, [])
  useEffect(() => () => setChatSlot('index', null), [])

  // v22 十轮：「星核」挂载入口 —— ChatArea 的 ComposerAttachPopover 原样
  // portal 进标题栏（技能 / 分身 / MCP），输入行不再放 ＋。
  const attachAttach = useCallback((node: HTMLSpanElement | null) => {
    setChatSlot('attach', node)
  }, [])
  useEffect(() => () => setChatSlot('attach', null), [])

  const computeDefaultRect = useCallback((): CockpitRect | null => {
    // v21 三轮：原型没有屏幕级底栏，通讯台底缘固定为 视口 − 56（geometry 的
    // fallback 口径），不再从 footer / composer 上沿反推。
    return cockpitConsoleRect({
      viewport: viewportSize(),
      footerTop: null,
      composerTop: null,
    })
  }, [])

  // 第一次开窗：量 arena 落默认几何；之后只在用户没动过时跟随布局（rAF 让
  // footer/ticker 的高度先落定，避免用上一帧的 arena 量出短一截的窗）。
  // v20：首帧 arena 还没布局（首载 / dev 冷启动 CSS 未到）时量不到 → 持续重试
  // 直到量到（rect 一旦落定 effect 自停），否则窗零尺寸、tab/grip 全 hidden。
  useEffect(() => {
    if (!open || rect) return
    let raf = 0
    const attempt = () => {
      const next = computeDefaultRect()
      if (next) {
        setRef.current({ rect: next })
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
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

  // v20：arena 布局变化（首载 CSS 未到 / 面开合 / 抽屉）时默认几何跟随，
  // 直到用户拖过/缩过（userAdjusted）才交还控制权。冷启动首帧量出窄 arena
  // 会把窗钉在最小宽 —— ResizeObserver 补这一拍（e2e 实测根因）。
  useEffect(() => {
    if (!open) return
    const arena = document.getElementById('ck12-arena')
    if (!arena || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (userAdjustedRef.current) return
      const next = computeDefaultRect()
      if (next) setRef.current({ rect: next })
    })
    observer.observe(arena)
    return () => observer.disconnect()
  }, [open, computeDefaultRect])

  // Esc 栈：流式中先停流，再按一次才收台。收起 = 停靠 pill（与 ✕ / ⌄ 同义）——
  // 只置 open:false 会把台藏掉却不给底栏展开控件，整台就找不回来了（用户反馈）。
  // docked 时不注册（pill 不是交互层）。
  const closeLayer = useCallback(() => {
    const current = chatRef.current
    if (current?.streaming) {
      current.stop()
      return
    }
    setRef.current({ docked: true })
  }, [])
  useEffect(() => {
    if (!open || docked) return
    return layer.register('cockpit-chat-window', CHAT_WINDOW_LAYER_PRIORITY, closeLayer)
  }, [open, docked, layer, closeLayer])

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
      : drag.mode === 'resize-l'
        ? resizeCockpitRectLeft(drag.rect, delta, viewportSize())
        : drag.mode === 'resize-t'
          ? resizeCockpitRectTop(drag.rect, delta, viewportSize())
          : resizeCockpitRect(drag.rect, delta, viewportSize())
    setRef.current({ rect: next })
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }, [])

  /** v20 grip 双击复位：交还默认几何（userAdjusted 清零）。 */
  const resetGeo = useCallback(() => {
    userAdjustedRef.current = false
    tallRestoreRef.current = null
    setRef.current({ rect: null })
  }, [])

  const toggleTall = useCallback(() => {
    const current = rectRef.current
    if (!current) return
    userAdjustedRef.current = true
    if (tallRestoreRef.current) {
      const restore = tallRestoreRef.current
      tallRestoreRef.current = null
      setRef.current({ rect: clampCockpitRect(restore, viewportSize()) })
      return
    }
    tallRestoreRef.current = current
    const vp = viewportSize()
    setRef.current({
      rect: clampCockpitRect({ ...current, y: 56, h: vp.height - 66 }, vp),
    })
  }, [])

  const bodyVisible = open && !mini && !docked

  return (
    <div
      ref={rootRef}
      className={`ck12-comms${mini ? ' is-mini' : ''}${pinned ? ' is-pinned' : ''}`}
      data-testid="cockpit-chat-window"
      data-open={open ? 'true' : 'false'}
      data-mini={mini ? 'true' : 'false'}
      data-docked={docked ? 'true' : 'false'}
      onPointerDownCapture={raiseConsole}
      style={{
        zIndex: z ?? undefined,
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.w ?? 0,
        height: rect?.h ?? 0,
        display: open && !docked ? undefined : 'none',
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
        <button
          type="button"
          className="ck12-comms-close"
          aria-label="收起通讯台"
          title="收起通讯台（停靠 pill 点击展开）"
          data-testid="cockpit-comms-close"
          onClick={() => setRef.current({ docked: true })}
        >
          <X className="ck12-comms-ico" aria-hidden="true" />
        </button>
        {/* v22 十轮：挂载入口（星核）—— 主线程时它就是原「主对话」标题的位置；
            作业线程仍保留 ▦ 标题。ChatArea portal 真面板进来。 */}
        <span
          ref={attachAttach}
          className="ck12-comms-attach-slot"
          data-testid="cockpit-attach-slot"
        />
        {/* 遥测：MODEL / CTX / TOKEN —— 都以芯片为中心向下展开、夹在台内。 */}
        <CockpitConsoleTelemetry />

        {/* 对话索引（≡ N 轮）：用户输入历史，点开在头部下方弹编号列表。 */}
        <span
          ref={attachIndex}
          className="ck12-comms-index-slot"
          data-testid="cockpit-chat-index-slot"
        />

        <span className="ck12-comms-spacer" />
        {/* 2026-11-27 用户：收起旁边挂汐音头像（桌面版 icon）—— 一眼认出这是主对话。
            点开 = 汐音档案（与 HUD「◐ 汐音」同一个浮层）。 */}
        <button
          type="button"
          className="ck12-comms-avatar"
          aria-label="汐音头像 · 主对话"
          title="汐音 · 主对话 · 点开汐音档案"
          data-testid="cockpit-comms-avatar"
          onClick={() => toggleCrewSettings()}
        >
          <img src="/cabin/xiyin-avatar.png" alt="汐音" />
        </button>
        {/* v22 #5：主通讯台固定主对话，头部只剩 ⌄ 收起（原型 .con-h）。 */}
        <button
          type="button"
          className="ck12-comms-act"
          aria-label="收起成停靠 pill"
          title="⌄ 收起停靠（⌥C）"
          data-testid="cockpit-comms-dock"
          onClick={() => setRef.current({ docked: true })}
        >
          ⌄ 收起
        </button>
      </header>

      {/* 常驻节点：关窗/收起只隐藏，不卸载 —— ChatPane 的 transcript portal 目标。
          wrapper 只多一层 relative 定位上下文，回执 overlay 住在里面。 */}
      <div
        className="ck12-comms-bodywrap"
        style={{ display: bodyVisible ? undefined : 'none' }}
      >
        <div
          ref={attachTranscript}
          className="ck12-comms-body"
          data-testid="cockpit-chat-transcript"
        />
        <CockpitReceipts threadKey={MAIN_THREAD_KEY} />
        {/* 2026-11-24 用户：事项投递排队条（主对话在跑时贴在输入行上方）。 */}
        <CockpitItemsQueue />
        {/* 2026-11-20 用户：输入框上方的「待你决断 · N 项 · 键 1–9 直达」条已移除 ——
            聊天内容里有提问卡、右栏也有 inbox，三条入口重复。 */}
        {/* v22 #9（2026-11-23 用户）：输入框上方不再有任何「待你定」浮条 ——
            提问只看转录里的卡片与右栏 inbox。原型 .con-in：❯ + 输入框 + ⏎。 */}
        <div className="ck12-comms-in">
          <div
            ref={attachComposer}
            className="ck12-comms-inslot"
            data-testid="cockpit-composer-slot"
            data-has-composer={composerSlot ? 'true' : 'false'}
          />
        </div>
      </div>

      <div
        className="ck12-comms-resize"
        role="separator"
        aria-label="缩放对话窗"
        onPointerDown={(event) => beginDrag(event, 'resize')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {/* v20 左缘 / 上缘 grip：hover 显形，双击复位默认几何。 */}
      <div
        className="ck12-comms-grip-l"
        role="separator"
        aria-label="左缘缩放"
        title="拖拽改宽 · 双击复位"
        onPointerDown={(event) => beginDrag(event, 'resize-l')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetGeo}
      />
      <div
        className="ck12-comms-grip-t"
        role="separator"
        aria-label="上缘缩放"
        title="拖拽改高 · 双击复位"
        onPointerDown={(event) => beginDrag(event, 'resize-t')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetGeo}
      />
    </div>
  )
}
