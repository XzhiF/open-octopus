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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { ChatPane } from '@/components/agent/chat/ChatPane'
import type { CwdChoice } from '@/components/agent/chat/cwd-picker'
import { registerCabinUserSession } from '@/lib/cabin-api'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCabinChatWiring } from '@/components/cabin/use-cabin-chat-wiring'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { nextZ } from '@/components/cabin/z-order'
import { moveCockpitRect, resizeCockpitRect, type Viewport } from './geometry'
import { useCockpitState } from '../state/CockpitStateProvider'
import { defaultTabForRef, type CockpitChatApi, type CockpitPopWin, type CockpitRect } from '../state/cockpit-state'
import { THREAD_EMO } from '../fleet/threads-model'
import { accentOfAnchor } from '../fleet/project-accent'
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
  // v23：本视图只接编队线程窗（threadKey 恒有；新会话窗走 CockpitSessionWinView）。
  const threadKey = win.threadKey ?? ''
  const thread = byKey.get(threadKey)

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
  const unread = threadApi.unread[threadKey] ?? 0
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
      data-thread={threadKey}
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
        <CockpitReceipts threadKey={threadKey} />
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

// v23（2026-11-27 用户）：编队「新会话」窗 —— 人工开一条会话，不经过汐音，
// 也不会占她的回合。空窗阶段不落库：发第一条消息才创建会话；创建后窗口原地
// 变成正式会话（不重开、不换 DOM），并在服务端登记成 origin=user 的委派 ——
// 与汐音委派同一本账、同一套状态机，编队 / 会话详情 / 汐音派活都是同一套。
// 它绑定的会话还没有编队线程 key，所以 threadKey 恒 null、靠 sessionId 承载。
function CockpitSessionWinView({
  win,
  shared,
}: {
  win: CockpitPopWin
  shared: ReturnType<typeof useCabinChatWiring>['shared']
}) {
  const { wins, layer, select, entryCabinId } = useCockpitState()
  const { cabin } = useCabinContext()
  // 登记委派后立刻刷一次编队，不用等 10s 轮询。
  const { rows: fleetRows, refetch: refetchFleet } = useCockpitFleet()
  const [sessionId, setSessionId] = useState<string | null>(win.sessionId)
  // 服务端委派 id（详情面的 ref）；登记回来后填，窗重开时也可从编队行反查。
  const [delegationId, setDelegationId] = useState<string | null>(null)
  const [identityLabel, setIdentityLabel] = useState<string | null>(null)
  const [z, setZ] = useState(() => nextZ())
  const bumpZ = useCallback(() => setZ(nextZ()), [])
  const activeWin = useActiveWin()
  const isFocus = activeWin === win.id
  useEffect(() => {
    if (!win.min) setActiveWin(win.id)
  }, [win.id, win.min])
  // 宿主侧绑定（发第一条消息）后，win.sessionId 落地；本地状态跟着走。
  useEffect(() => { setSessionId(win.sessionId) }, [win.sessionId])

  const [telemetry, setTelemetry] = useState<CockpitChatApi | null>(null)
  const [indexSlot, setIndexSlot] = useState<HTMLSpanElement | null>(null)
  const [attachSlot, setAttachSlot] = useState<HTMLSpanElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<WinDrag | null>(null)
  const rectRef = useRef(win.rect)
  useEffect(() => { rectRef.current = win.rect }, [win.rect])

  // 草稿窗打开即聚焦输入框（点「新会话」就该能直接打；创建后不再抢焦点）。
  useEffect(() => {
    if (sessionId) return
    const raf = requestAnimationFrame(() => {
      rootRef.current?.querySelector('textarea')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [sessionId])

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

  const isDraft = !sessionId
  const activeSession = sessionId ? shared.sessions.find((session) => session.id === sessionId) : undefined
  // 服务端默认标题就是「新会话」—— 那不算真标题：先用第一句话当抬头，
  // 等自动起好标题（≠ 新会话）再同步窗头 + 编队台账行。
  const serverTitle = activeSession?.title && activeSession.title !== '新会话'
    ? activeSession.title
    : null
  const liveTitle = serverTitle || win.title || '新会话'
  useEffect(() => {
    if (!sessionId || !serverTitle || serverTitle === win.title) return
    wins.renameWindow(win.id, serverTitle)
  }, [sessionId, serverTitle, win.title, wins, win.id])

  // v23（2026-11-27 用户）：在作战舱里新建的会话，默认工作区就是舱自己的
  // 工作空间（舱目录），与舱内其它工作面同源；三件套里仍可改。
  const defaultCwd = useMemo<CwdChoice | undefined>(() => {
    if (!cabin?.workspace_id) return undefined
    const workspace = shared.workspaces.find((item) => item.id === cabin.workspace_id)
    return {
      kind: 'workspace',
      workspaceId: cabin.workspace_id,
      path: cabin.path,
      label: workspace?.name ?? cabin.name,
    }
  }, [cabin?.workspace_id, cabin?.path, cabin?.name, shared.workspaces])

  const minimize = () => {
    if (activeWin === win.id) setActiveWin(null)
    wins.setWindowMin(win.id, true)
  }
  // 登记结果回来后直接用；窗口重开（同会话）时从编队行反查 —— doer_session_id 命中。
  const resolvedDelegationId = useMemo(() => {
    if (delegationId) return delegationId
    if (!sessionId) return null
    const row = fleetRows.find((item) => (
      item.kind === 'delegation' && item.delegation.doer_session_id === sessionId
    ))
    return row?.kind === 'delegation' ? row.delegation.id : null
  }, [delegationId, sessionId, fleetRows])

  // v23（2026-11-27 用户）：会话也有自己的详情 —— 打开它的六页签详情面（窗留着）。
  const openDetail = () => {
    if (!resolvedDelegationId) return
    select({ kind: 'delegation', cabinId: entryCabinId, id: resolvedDelegationId }, 'relay')
  }
  const identity = isDraft
    ? '待创建'
    : (identityLabel ?? activeSession?.clone_name ?? '主 Agent')
  // 草稿保留通讯台的薄荷青；创建后按会话 id 锚一个项目色（与编队行同算法）。
  const accent = sessionId ? accentOfAnchor(`session:${sessionId}`) : 'var(--ck12-sky)'
  const layerRoot = typeof document !== 'undefined'
    ? document.getElementById('ck12-layer-root')
    : null

  const onSessionCreated = (session: { id: string; title?: string | null }, info: {
    clone: string | null
    cloneLabel: string | null
    firstMessage: string
  }) => {
    // 服务端默认标题常常就是「新会话」—— 那种情况先拿第一句话当抬头，等自动
    // 起好标题后由上面的 effect 换成真正的标题。
    const first = (info.firstMessage.trim().split('\n')[0] || '').trim().slice(0, 24)
    const title = session.title && session.title !== '新会话' ? session.title : (first || '新会话')
    if (info.cloneLabel) setIdentityLabel(info.cloneLabel)
    else if (info.clone) setIdentityLabel(info.clone)
    setSessionId(session.id)
    // 窗口原地转正（不重开、不换 DOM）。
    wins.bindSession(win.id, session.id, title)
    // 2026-11-27 用户：这条会话跟汐音开的会话是同一本账 —— 登记成
    // origin=user 的委派；编队 / 会话详情 / 汐音派活（cabin_send_to_session）共用一套。
    // 登记失败只影响「进编队」，不影响会话本身。
    void registerCabinUserSession(entryCabinId, {
      session_id: session.id,
      title,
      intent: info.firstMessage,
    }).then((delegation) => {
      setDelegationId(delegation.id)
      refetchFleet()
    }).catch(() => {
      toast.error('会话已创建，但没登记进编队（服务端登记失败）')
    })
  }

  return (
    <div
      ref={rootRef}
      className={`ck12-cwin${win.min ? ' is-min' : ''}${isFocus ? ' is-focus' : ''}`}
      data-testid={`cockpit-win-${win.id}`}
      data-session={sessionId ?? undefined}
      data-draft={isDraft ? 'true' : undefined}
      data-focus={isFocus ? 'true' : undefined}
      onPointerDownCapture={() => { bumpZ(); setActiveWin(win.id) }}
      style={{
        zIndex: z,
        left: win.rect.x,
        top: win.rect.y,
        width: win.rect.w,
        height: win.rect.h,
        display: win.min ? 'none' : undefined,
        ['--waccent' as string]: accent,
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
          aria-label="关闭窗口"
          title={isDraft ? '关闭（没发消息就不会创建会话）' : '关闭（会话仍保留在编队）'}
          onClick={close}
        >
          <X className="ck12-cwin-ico" aria-hidden="true" />
        </button>
        {/* 星核（技能 / 分身 / MCP）—— 与其它 chat 窗同位。 */}
        <span
          ref={setAttachSlot}
          className="ck12-cwin-attach"
          data-testid={`cockpit-win-attach-${win.id}`}
        />
        {sessionId && win.rect.w >= 640 && (
          <CockpitConsoleTelemetry
            chat={telemetry}
            hostSelector=".ck12-cwin"
            scope={`win-${win.id}`}
          />
        )}
        {sessionId && (
          <span
            ref={setIndexSlot}
            className="ck12-cwin-idx"
            data-testid={`cockpit-win-index-${win.id}`}
          />
        )}
        <span className="ck12-cwin-sp" aria-hidden="true" />
        <span className="ck12-cwin-emo" aria-hidden="true">{isDraft ? '✚' : '💬'}</span>
        {win.rect.w >= 460 && (
          <span className="ck12-cwin-id" data-testid={`cockpit-win-identity-${win.id}`}>{identity}</span>
        )}
        {sessionId ? (
          <button
            type="button"
            className="ck12-cwin-title"
            title={`点击看详情 · ${liveTitle}`}
            data-testid={`cockpit-win-title-${win.id}`}
            onClick={openDetail}
          >
            {liveTitle}
          </button>
        ) : (
          <span
            className="ck12-cwin-title"
            title="发第一条消息才创建会话"
            data-testid={`cockpit-win-title-${win.id}`}
          >
            新会话
          </span>
        )}
        {sessionId && (
          <button
            type="button"
            className="ck12-comms-act"
            aria-label="会话详情"
            title="▦ 会话详情（对接 / 文件 / 运行 / 调试 / 消耗 / 子代理）"
            data-testid={`cockpit-win-detail-${win.id}`}
            onClick={openDetail}
          >
            ▦ 详情
          </button>
        )}
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
          // 纯会话不属于舱线程：身份跟随会话自己的角色卡（分身选择器在 hero 行里）。
          cabinId={null}
          cabinWorkspaceId={null}
          chromeInline
          workspaceIdOverride={activeSession?.workspace_id ?? null}
          indexSlot={indexSlot}
          attachSlot={attachSlot}
          chromeHostSelector=".ck12-cwin"
          onTelemetry={setTelemetry}
          composerVariant="cockpit"
          hideDock
          newSessionOptions={isDraft}
          onSessionCreated={onSessionCreated}
          defaultCwd={defaultCwd}
        />
      </div>

      <div
        className="ck12-cwin-resize"
        role="separator"
        aria-label="缩放窗口"
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
      {wins.windows.map((win) => (
        win.threadKey
          ? <CockpitPopWinView key={win.id} win={win} shared={shared} />
          : <CockpitSessionWinView key={win.id} win={win} shared={shared} />
      ))}
    </>
  )
}
