'use client'

// S5 owns this file —— 浮动对话窗（v12 .comms → v20 通讯台）。
//
//   position:fixed; z-index:24；默认几何来自 arena + .ck12-scene 的 paddingLeft
//   （plans §0.3），经 chat/geometry 夹回视口；
//   header 灯组在左：关闭 / 收起 / 锁定（X / Minus / Pin 图标，DOM 顺序就是
//   前三颗可聚焦元素），右侧只放拖拽握把与只读读数；右下 18px 缩放；
//   锁定后拖不动；收起成 47px；
//   ◍ 五档 94/82/70/55/100 写 --oa（底板透、字不透）。
//
// v20（design 29 §3/§5）增量：
//   · 多作战 tab 条（状态表情 / 未读 / ✕ 关闭 / 回传重开）；
//   · TUI 选项行（当前线程待决断，键 1–9）+ 本地同步回执 overlay；
//   · 左缘 / 上缘 grip 缩放（双击复位默认几何）；
//   · ⌄ 整台收起成停靠 pill（docked，比 mini 更彻底）；
//   · ⧉ 弹出作战窗（仅用户主动，上限 5）· ▦ 详情 · ⚙ 调试 · ⌃ 加高。
//
// **常驻挂载**：关闭只把 root 切成 display:none，header/body 两个 DOM 节点不动 ——
// body 是 ChatPane transcript 的 portal 挂载点（模块级 chat-slots），节点一换
// ChatPane 就会重挂。composer 已 portal 到底栏，不受隐藏祖先影响，关窗后底栏
// 仍能输入（plans §2.4）。
//
// Esc：由 CockpitLayerStack 统一处理（priority 60 = 作业面之上、其它弹层之下）。
// 流式中先停流（与 composer 内 Esc 同语义），再按一次才收窗。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, Pin, PinOff, X } from 'lucide-react'
import { toast } from 'sonner'
import { useCockpitState } from '../state/CockpitStateProvider'
import { nextZ } from '@/components/cabin/z-order'
import { setChatSlot } from './chat-slots'
import {
  CHAT_MINI_HEIGHT,
  cascadeWinRect,
  clampCockpitRect,
  cockpitConsoleRect,
  miniCockpitRect,
  moveCockpitRect,
  nextCockpitAlpha,
  resizeCockpitRect,
  resizeCockpitRectLeft,
  resizeCockpitRectTop,
  type Viewport,
} from './geometry'
import type { CockpitRect } from '../state/cockpit-state'
import { THREAD_STATE_LABEL } from '../fleet/threads-model'
import { CockpitThreadTabs } from './CockpitThreadTabs'
import { CockpitConsoleFooter } from './CockpitConsoleFooter'
import { CockpitChoices } from './CockpitChoices'
import { CockpitReceipts } from './CockpitReceipts'
import { useCockpitThreads } from './use-cockpit-threads'

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
  const { chatWindow, chat, layer, wins, select, threads: threadApi } = useCockpitState()
  const { active } = useCockpitThreads()
  const {
    open, mini, pinned, alpha, rect, docked,
  } = chatWindow

  const rootRef = useRef<HTMLDivElement>(null)
  /** 共享 z 栈（design 26 §5.3）：打开 / 聚焦即置顶，问答窗反而能再压回来。 */
  const [z, setZ] = useState<number | null>(null)
  const bumpZ = useCallback(() => setZ(nextZ()), [])
  const dragRef = useRef<DragState | null>(null)
  const restoreHeightRef = useRef<number | null>(null)
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
    window.addEventListener('octopus:chat-focus', bumpZ)
    return () => window.removeEventListener('octopus:chat-focus', bumpZ)
  }, [bumpZ])

  const attachTranscript = useCallback((node: HTMLDivElement | null) => {
    setChatSlot('transcript', node)
  }, [])
  useEffect(() => () => setChatSlot('transcript', null), [])

  // 标题栏「对话索引」挂载点：ChatTimeline（compact）portal 进来。
  // 正文右侧不再有任何常驻控件 —— 索引只存在于窗框里。
  const attachIndex = useCallback((node: HTMLSpanElement | null) => {
    setChatSlot('index', node)
  }, [])
  useEffect(() => () => setChatSlot('index', null), [])

  const computeDefaultRect = useCallback((): CockpitRect | null => {
    // v21（design 31 §2.1）：几何直接按视口量，不再从 arena / .ck12-scene 推 ——
    // 左缘贴立绘右缘 −22、右缘让出右栏；底缘贴 composer 输入槽上沿（底栏高度
    // 随断点 / 控件换行变，固定 56 会露缝或被盖住）。
    const footer = document.querySelector<HTMLElement>('.ck12-cmd')
    const footerTop = footer ? footer.getBoundingClientRect().top : null
    const composer = document.querySelector<HTMLElement>('[data-testid="cockpit-command-bar"]')
    const composerTop = composer ? composer.getBoundingClientRect().top : null
    return cockpitConsoleRect({
      viewport: viewportSize(),
      footerTop: footerTop && footerTop > 0 ? footerTop : null,
      composerTop: composerTop && composerTop > 0 ? composerTop : null,
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

  // Esc 栈：流式中先停流，再按一次才收窗。docked 时不注册（pill 不是交互层）。
  const closeLayer = useCallback(() => {
    const current = chatRef.current
    if (current?.streaming) {
      current.stop()
      return
    }
    setRef.current({ open: false })
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

  /** v20 ⌃ 加高：顶到 HUD 下沿、底贴舱壁；再点还原。 */
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

  // v21：「更多 → 日志」= 展开通讯台并切全日志（⌃）。
  useEffect(() => {
    const onTall = () => {
      setRef.current({ open: true, mini: false, docked: false })
      requestAnimationFrame(() => toggleTall())
    }
    window.addEventListener('octopus:chat-tall', onTall)
    return () => window.removeEventListener('octopus:chat-tall', onTall)
  }, [toggleTall])

  /** v20 ⧉ 弹出：仅用户主动；同线程已存在则聚焦；上限 5 toast 拒绝。 */
  const popOut = useCallback(() => {
    if (active.key === 'main') return
    const ok = wins.openWindow(active.key, cascadeWinRect(wins.windows.length, viewportSize()))
    if (!ok) toast.error('弹出窗最多 5 个 —— 先关一扇再开')
  }, [active.key, wins])

  const bodyVisible = open && !mini && !docked
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
      data-docked={docked ? 'true' : 'false'}
      onPointerDownCapture={bumpZ}
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
      <span className="ck12-cbr is-tl" aria-hidden="true" />
      <span className="ck12-cbr is-br" aria-hidden="true" />
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
            <X className="ck12-comms-ico" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-min"
            aria-label={mini ? '展开对话窗' : '收起对话窗'}
            aria-pressed={mini}
            title={mini ? '展开（47px）' : '收起（47px）'}
            onClick={toggleMini}
          >
            <Minus className="ck12-comms-ico" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-pin"
            aria-label="锁定位置"
            aria-pressed={pinned}
            title={pinned ? '解除锁定' : '锁定位置与大小'}
            onClick={() => setRef.current({ pinned: !pinned })}
          >
            {pinned
              ? <PinOff className="ck12-comms-ico" aria-hidden="true" />
              : <Pin className="ck12-comms-ico" aria-hidden="true" />}
          </button>
        </div>

        <span className="ck12-comms-glyph" aria-hidden="true">⬢</span>
        <span className="ck12-comms-ident">
          <b className="ck12-comms-title" data-testid="cockpit-comms-title">
            {active.kind === 'main' ? '主对话' : active.short}
          </b>
          <span className="ck12-comms-sub2">
            {active.kind === 'main'
              ? '汐音 · 舰桥频道'
              : `${THREAD_STATE_LABEL[active.state]} · ${active.short}`}
          </span>
        </span>
        <span className="ck12-comms-status" data-state={chat?.streaming ? 'streaming' : 'idle'}>
          {statusText}
        </span>
        {/* 对话索引（用户输入历史）挂在标题栏里，由 ChatTimeline 的 compact 档
            portal 进来；正文区零常驻控件。mini（47px）时整槽隐藏。 */}
        <span
          ref={attachIndex}
          className="ck12-comms-index-slot"
          data-testid="cockpit-chat-index-slot"
        />
        <span className="ck12-comms-grip" aria-hidden="true">⠿</span>
        {/* v21（design 31 §3.2）：头按钮组按原型从左到右
            ← 主对话 / ⚙ 调试 / ▦ 详情 / ⧉ 弹出 / ⌄ 收起 / ⌃ 全日志。 */}
        {active.key !== 'main' && (
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-act"
            aria-label="回到主对话"
            title="← 回到主对话"
            data-testid="cockpit-comms-back"
            onClick={() => threadApi.activateThread('main')}
          >
            ← 主对话
          </button>
        )}
        {active.ref && (
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-act ck12-comms-dbg"
            aria-label="看调试 inspect"
            title="⚙ 调试 inspect"
            data-testid="cockpit-comms-debug"
            onClick={() => select(active.ref, 'debug')}
          >
            ⚙ 调试
          </button>
        )}
        {active.ref && (
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-act"
            aria-label="看作战详情"
            title="▦ 作战详情"
            data-testid="cockpit-comms-detail"
            onClick={() => select(active.ref)}
          >
            ▦ 详情
          </button>
        )}
        {active.key !== 'main' && (
          <button
            type="button"
            className="ck12-comms-btn ck12-comms-act"
            aria-label="弹出作战窗"
            title="⧉ 弹出成独立窗（最多 5 个）"
            data-testid="cockpit-popout"
            onClick={popOut}
          >
            ⧉ 弹出
          </button>
        )}
        <button
          type="button"
          className="ck12-comms-btn ck12-comms-act"
          aria-label="收起成停靠 pill"
          title="⌄ 收起停靠（⌥C）"
          data-testid="cockpit-comms-dock"
          onClick={() => setRef.current({ docked: true })}
        >
          ⌄ 收起
        </button>
        <button
          type="button"
          className="ck12-comms-btn ck12-comms-act ck12-comms-tall"
          aria-label="加高通讯台"
          title="⌃ 全日志加高 / 还原"
          onClick={toggleTall}
        >
          ⌃ 全日志
        </button>
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

      {!mini && <CockpitThreadTabs />}

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
        <CockpitReceipts threadKey={active.key} />
      </div>

      {bodyVisible && <CockpitChoices />}

      {!mini && <CockpitConsoleFooter />}

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
