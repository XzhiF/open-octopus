'use client'

// v20（design 29 §4）：用户自开的作战弹出窗（上限 5，入口只有通讯台 ⧉）。
//
// 每扇窗 = 一个真 ChatPane（绑该线程会话，composer 内联在窗底），不是转录快照：
// 窗内能直接回话，走与主通讯台同一套服务端管线。共享 z 栈（cabin/z-order），
// 聚焦只改 inline z / class，不重建 DOM（重建会吞掉本次 click —— 原型五轮根因）。
// 最小化 → WINDOWS 条 chip 虚线态；关闭 → 线程历史仍在 tab / 面板可回。
//
// v22 #5（2026-11-23 用户）：这扇窗就是跟该编队 agent 的直聊 —— 直接回复、
// 流式输出与主 chat 同管线；身份用线程身份（执行者 / 作者 / 委派执行者），
// 不再有「回主对话」条，也不再把任务线程锁成只读兜底。

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ChatPane } from '@/components/agent/chat/ChatPane'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCabinChatWiring } from '@/components/cabin/use-cabin-chat-wiring'
import { nextZ } from '@/components/cabin/z-order'
import { moveCockpitRect, resizeCockpitRect, type Viewport } from './geometry'
import { useCockpitState } from '../state/CockpitStateProvider'
import { defaultTabForRef, type CockpitChatApi, type CockpitPopWin, type CockpitRect } from '../state/cockpit-state'
import { THREAD_EMO } from '../fleet/threads-model'
import { CockpitConsoleTelemetry } from './CockpitConsoleTelemetry'
import { CockpitReceipts } from './CockpitReceipts'
import { useCockpitThreads } from './use-cockpit-threads'
import { setActiveWin, useActiveWin } from './active-win'

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

function CockpitPopWinView({
  win,
  shared,
}: {
  win: CockpitPopWin
  shared: ReturnType<typeof useCabinChatWiring>['shared']
}) {
  const { wins, layer, threads: threadApi, select } = useCockpitState()
  const { cabinId, cabin } = useCabinContext()
  const { byKey } = useCockpitThreads()
  const thread = byKey.get(win.threadKey)

  const [z, setZ] = useState(() => nextZ())
  const bumpZ = useCallback(() => setZ(nextZ()), [])
  // v22（2026-11-27）：置顶窗的加粗光晕（原型 .cwin.focus）。共享焦点态只做
  // 视觉，真正的层级仍由 nextZ 决定。
  const activeWin = useActiveWin()
  const isFocus = activeWin === win.id
  useEffect(() => {
    if (!win.min) setActiveWin(win.id)
  }, [win.id, win.min])
  const [sessionId, setSessionId] = useState<string | null>(thread?.sessionId ?? null)
  // v22 #5：这扇窗自己的遥测（模型 / CTX / token·费用）—— ChatPane 按窗上报，
  // 与主通讯台同一形状，但绝不串台。
  const [telemetry, setTelemetry] = useState<CockpitChatApi | null>(null)
  // 窗头「≡ N 轮」索引槽：ChatTimeline（compact）portal 进来，跳转只滚本窗转录。
  const [indexSlot, setIndexSlot] = useState<HTMLSpanElement | null>(null)
  // 窗头「星核」挂载槽（2026-11-23 用户：技能 / 分身入口跟主 chat 一样在左上，
  // 不在输入行 ⏎ 左边）—— ComposerAttachPopover portal 进这里。
  const [attachSlot, setAttachSlot] = useState<HTMLSpanElement | null>(null)
  const dragRef = useRef<WinDrag | null>(null)
  const rectRef = useRef(win.rect)
  useEffect(() => { rectRef.current = win.rect }, [win.rect])
  useEffect(() => { setSessionId(thread?.sessionId ?? null) }, [thread?.sessionId])

  useEffect(() => {
    const onFocus = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === win.id) {
        bumpZ()
        setActiveWin(win.id)
      }
    }
    window.addEventListener('octopus:cockpit-win-focus', onFocus)
    return () => window.removeEventListener('octopus:cockpit-win-focus', onFocus)
  }, [win.id, bumpZ])

  const close = useCallback(() => {
    if (activeWin === win.id) setActiveWin(null)
    wins.closeWindow(win.id)
  }, [wins, win.id, activeWin])
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

  if (!thread) return null
  const unread = threadApi.unread[win.threadKey] ?? 0
  const ref = thread.ref
  const openDetail = () => { if (ref) select(ref, defaultTabForRef(ref)) }
  const minimize = () => {
    if (activeWin === win.id) setActiveWin(null)
    wins.setWindowMin(win.id, true)
  }
  const detailLabel = thread.kind === 'delegation' ? '会话详情' : '作战详情'
  // 任务线程的 workspace 由任务行兜底：session_updated（尾随流 / 服务端卡片）
  // 按 workspace 分发，窗口不持 activeTask 时不能只退到舱工作区。
  const taskWorkspaceId = thread.taskId
    ? shared.chatTasks.find((task) => task.id === thread.taskId)?.workspace_id ?? null
    : null
  const layerRoot = typeof document !== 'undefined'
    ? document.getElementById('ck12-layer-root')
    : null

  return (
    <div
      className={`ck12-cwin${win.min ? ' is-min' : ''}${isFocus ? ' is-focus' : ''}`}
      data-testid={`cockpit-win-${win.id}`}
      data-thread={win.threadKey}
      data-focus={isFocus ? 'true' : undefined}
      onPointerDownCapture={() => { bumpZ(); setActiveWin(win.id) }}
      style={{
        zIndex: z,
        left: win.rect.x,
        top: win.rect.y,
        width: win.rect.w,
        height: win.rect.h,
        display: win.min ? 'none' : undefined,
        // v22（2026-11-27）：每扇窗一个项目色 —— 边框 / 顶条 / 头带 / 输入焦点 /
        // 光晕共用；主通讯台的薄荷青保持不变，形成明显对比。
        ['--waccent' as string]: thread.accent,
      }}
    >
      <header
        className="ck12-cwin-head"
        onPointerDown={(event) => beginDrag(event, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* 舱系口径：✕ 一律在容器最左。 */}
        <button
          type="button"
          className="ck12-cwin-btn ck12-cwin-close"
          aria-label="关闭弹出窗"
          title="关闭（历史保留在 tab）"
          onClick={close}
        >
          <X className="ck12-cwin-ico" aria-hidden="true" />
        </button>
        {/* 星核（技能 / 分身 / MCP）—— 与主通讯台同位：紧跟 ✕，同 26px 圆形星环。 */}
        <span
          ref={setAttachSlot}
          className="ck12-cwin-attach"
          data-testid={`cockpit-win-attach-${win.id}`}
        />
        {/* 遥测：与主通讯台同一套芯片 + 同一份真源（本窗自己的会话）。窗太窄时不画，
            保住名称与按钮。 */}
        {win.rect.w >= 640 && (
          <CockpitConsoleTelemetry
            chat={telemetry}
            hostSelector=".ck12-cwin"
            scope={`win-${win.id}`}
          />
        )}
        {/* ≡ N 轮：ChatTimeline（compact）portal 进这个槽，点开可跳本窗的某一轮。 */}
        <span
          ref={setIndexSlot}
          className="ck12-cwin-idx"
          data-testid={`cockpit-win-index-${win.id}`}
        />
        {/* 遥测 / 轮次贴左侧排（与主通讯台同序），余量在中间；窗自己的东西在右侧。 */}
        <span className="ck12-cwin-sp" aria-hidden="true" />
        {unread > 0 && <i className="ck12-cwin-unread">{unread > 9 ? '9+' : unread}</i>}
        <span className="ck12-cwin-emo" aria-hidden="true">{THREAD_EMO[thread.state]}</span>
        {/* v22 #5：在跟谁说话 —— 线程身份（执行者 / 作者 / 委派执行者）。 */}
        {win.rect.w >= 460 && (
          <span className="ck12-cwin-id" data-testid={`cockpit-win-identity-${win.id}`}>{thread.identity}</span>
        )}
        {/* 2026-11-27 用户：会话 / 任务名称紧贴「▦ 详情」左边；点名称等同点详情。 */}
        {ref ? (
          <button
            type="button"
            className="ck12-cwin-title"
            title={`点击看详情 · ${thread.title}`}
            data-testid={`cockpit-win-title-${win.id}`}
            onClick={openDetail}
          >
            {thread.title}
          </button>
        ) : (
          <span className="ck12-cwin-title">{thread.title}</span>
        )}
        {ref && (
          <button
            type="button"
            className="ck12-comms-act"
            aria-label={detailLabel}
            title={thread.kind === 'delegation'
              ? '▦ 会话详情（对接 / 文件 / 运行 / 调试 / 消耗 / 子代理）'
              : '▦ 作战详情（窗留着）'}
            data-testid={`cockpit-win-detail-${win.id}`}
            onClick={openDetail}
          >
            ▦ 详情
          </button>
        )}
        {/* 收起 = 最小化进 WINDOWS 条（与主通讯台的 ⌄ 收起同形）。 */}
        <button
          type="button"
          className="ck12-comms-act"
          aria-label="收起窗口（最小化到 WINDOWS 条）"
          title="⌄ 收起 · WINDOWS 条可恢复"
          data-testid={`cockpit-win-min-${win.id}`}
          onClick={minimize}
        >
          ⌄ 收起
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
          directThreadIdentity={thread.identity}
          chromeInline
          workspaceIdOverride={taskWorkspaceId}
          indexSlot={indexSlot}
          attachSlot={attachSlot}
          chromeHostSelector=".ck12-cwin"
          onTelemetry={setTelemetry}
          composerVariant="cockpit"
          hideDock
        />
        <CockpitReceipts threadKey={win.threadKey} />
      </div>

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
  // 无窗不挂接线：useCabinChatWiring 会拉会话/任务/运行态，别为了空列表白轮询。
  if (!wins.windows.length) return null
  return <CockpitPopWindowsBody />
}

function CockpitPopWindowsBody() {
  const { wins } = useCockpitState()
  // 接线（会话 / 任务 / 运行态 / 共享 shared）只跑一份：每扇窗各自调
  // useCabinChatWiring 会按窗数重复轮询并重复注册事件监听。
  const { shared } = useCabinChatWiring({ sidebarWidth: 0 })
  return (
    <>
      {wins.windows.map((win) => <CockpitPopWinView key={win.id} win={win} shared={shared} />)}
    </>
  )
}
