'use client'

// S5 owns this file —— 全域座舱的聊天宿主。
//
// 从 CabinChatHost 抽出的会话解析 / shared / command / 事件桥（见
// components/cabin/use-cabin-chat-wiring.ts），这里只负责全域这一侧的接线：
//   · 渲染**真的** ChatPane，并把 transcript portal 进浮窗的 body；
//   · composer 通过 composerSlot portal 到底栏 54px 输入区（plans §2.4）；
//   · onTelemetry → CockpitState.reportChat（舰桥 / ticker 读它）；
//   · layerRoot = #ck12-arena（任务模块窗浮在整个舱面上，不夹在 320px 浮窗里）；
//   · **全程挂载**：浮窗关闭/收起只改 chatWindow 状态，ChatPane 不卸载 —— 底下
//     ChatPane 的 UI 由浮窗的 display:none 隐藏，composer 已 portal 到底栏，
//     不受隐藏祖先影响。
//
// 无主会话时**不挂** ChatPane：否则回到空会话时 composer 会在第一次发送时懒建
// 一个新会话，绕开舱主对话的绑定。此时 telemetry 保持 null（舰桥显示未就绪），
// 底栏由 CockpitCommandBar 显示禁用文案。

import { memo, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatPane } from '@/components/agent/chat/ChatPane'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useCabinChatWiring } from '@/components/cabin/use-cabin-chat-wiring'
import { getTask } from '@/lib/tasks-api'
import { useCockpitState } from '../state/CockpitStateProvider'
import { threadKeyOfSession } from '../fleet/threads-model'
import { useChatSlot } from './chat-slots'
import { useCockpitThreads } from './use-cockpit-threads'

export interface CockpitChatHostProps {
  entryCabinId: string
}

/** ChatPane 是舱里最重的子树（整段转录 + 编辑器）。CockpitStateProvider 会因
 *  选择 / 特效 / 遥测等任意状态变化重渲染宿主，但那些变化与转录无关 ——
 *  memo 让宿主重渲染时不再重跑整棵 ChatPane（2026-11-16 全舱卡顿优化）。 */
const MemoChatPane = memo(ChatPane)

export function CockpitChatHost({ entryCabinId }: CockpitChatHostProps) {
  const { cabinId, cabin } = useCabinContext()
  const { reportChat, chatWindow } = useCockpitState()
  const { setStreaming } = useCockpit()
  const transcriptSlot = useChatSlot('transcript')
  const composerSlot = useChatSlot('composer')

  // 2026-11-16（design 23 §2）：切面会自动收起对话浮窗（ce078160），但
  // 「去处理 / 去任务对话」只发 octopus:open-task —— 不重新开窗的话，任务线程
  // 已经切过去了，人却看到一张没反应的作业面。凡是「打开任务」的入口都从这里
  // 统一把浮窗展开（CockpitBrief 也是 select + openWithFocus 的同一语义）。
  useEffect(() => {
    const onOpenTask = () => chatWindow.openWithFocus()
    // 就地回答（design 23 §2 续）：attention 面「在对话里回答」只发事件，
    // 浮窗同样要展开；滚动到具体卡片由转录里的 AuthorAskInbox 负责。
    const onOpenAsk = () => chatWindow.openWithFocus()
    // 作业面「去主对话」：切面会自动收窗（ce078160），只切会话不展开浮窗的话
    // 人看到的是「点了没反应」—— 与「去任务对话」同样先开窗。
    const onMainChat = () => chatWindow.openWithFocus()
    window.addEventListener('octopus:open-task', onOpenTask)
    window.addEventListener('octopus:open-ask', onOpenAsk)
    window.addEventListener('octopus:cabin-main-chat', onMainChat)
    return () => {
      window.removeEventListener('octopus:open-task', onOpenTask)
      window.removeEventListener('octopus:open-ask', onOpenAsk)
      window.removeEventListener('octopus:cabin-main-chat', onMainChat)
    }
  }, [chatWindow])

  const {
    sessionId, setSessionId,
    activeTask, setActiveTask,
    pendingTaskSession, setPendingTaskSession,
    command, issueCommand,
    mainSessionId, shared,
  } = useCabinChatWiring({ sidebarWidth: 0 })

  // design 25 §4.2：委派行点开 = doer 会话（证据面）。委派没有 cockpit ref
  // （它不占用 task:/job: 命名空间），所以走独立的 open-session 事件。
  useEffect(() => {
    const onOpenSession = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      if (!id) return
      issueCommand({ type: 'select-session', sessionId: id })
      chatWindow.openWithFocus()
    }
    window.addEventListener('octopus:open-session', onOpenSession)
    return () => window.removeEventListener('octopus:open-session', onOpenSession)
  }, [issueCommand, chatWindow])

  // layerRoot：任务模块窗（运行 / YAML / 子代理）挂在整个舱面之上。
  // 注意不能挂 #ck12-arena —— arena 在 .ck12-stage 的 stacking context（z-index:2）里，
  // 子节点 z-[60] 也压不过 fixed 的聊天浮窗（z-index:24）。所以用一个与 .ck12-app
  // 同大的独立层（z-index:25，pointer-events:none）。换舱整舱重挂，取一次即可。
  const [layerRoot, setLayerRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setLayerRoot(document.getElementById('ck12-layer-root') ?? document.getElementById('ck12-arena'))
  }, [entryCabinId])

  const noop = useCallback(() => {}, [])
  const handleStreamingChange = useCallback((sid: string | null) => {
    setStreaming(sid !== null)
  }, [setStreaming])
  const handleOpenSession = useCallback((id: string) => {
    issueCommand({ type: 'select-session', sessionId: id })
  }, [issueCommand])
  const backToCabinMain = useCallback(() => {
    if (mainSessionId) issueCommand({ type: 'select-session', sessionId: mainSessionId })
  }, [issueCommand, mainSessionId])

  // ── v20（design 29 §3.2）：线程 tab ↔ 真会话双向同步 ─────────────────
  // tab 激活 → 切 ChatPane 会话（task 线程走 select-task 带任务上下文）；
  // 会话被别处切换（卡片 / 事件）→ 反写 tab 高亮 + 消未读。
  const { threads: threadApi } = useCockpitState()
  const { threads, byKey } = useCockpitThreads()
  const activeThread = byKey.get(threadApi.activeThread)
  const activeSessionId = activeThread?.sessionId ?? null
  const activeTaskId = activeThread?.taskId ?? null

  useEffect(() => {
    if (!activeSessionId || activeSessionId === sessionId) return
    if (activeTaskId) {
      let cancelled = false
      getTask(activeTaskId)
        .then((task) => {
          if (!cancelled) issueCommand({ type: 'select-task', task })
        })
        .catch(() => {
          if (!cancelled) issueCommand({ type: 'select-session', sessionId: activeSessionId })
        })
      return () => { cancelled = true }
    }
    issueCommand({ type: 'select-session', sessionId: activeSessionId })
  }, [activeSessionId, activeTaskId, sessionId, issueCommand])

  useEffect(() => {
    const key = threadKeyOfSession(threads, sessionId)
    if (key && key !== threadApi.activeThread) threadApi.activateThread(key)
  }, [sessionId, threads, threadApi])

  if (!mainSessionId) return null

  const pane = (
    <MemoChatPane
      pane="left"
      split={false}
      focused
      secondary={false}
      sessionId={sessionId}
      setSessionId={setSessionId}
      activeTask={activeTask}
      setActiveTask={setActiveTask}
      pendingTaskSession={pendingTaskSession}
      setPendingTaskSession={setPendingTaskSession}
      command={command}
      layerRoot={layerRoot}
      otherSessionId={null}
      otherTaskId={null}
      onOpenSession={handleOpenSession}
      shared={shared}
      onFocus={noop}
      onStreamingChange={handleStreamingChange}
      onOpenSidebar={noop}
      onExitSplit={noop}
      onSwapPanes={noop}
      canSwap={false}
      cabinId={cabinId}
      cabinWorkspaceId={cabin?.workspace_id ?? null}
      cabinMainSessionId={mainSessionId}
      onBackToCabinMain={backToCabinMain}
      composerSlot={composerSlot}
      composerVariant="cockpit"
      onTelemetry={reportChat}
      hideDock
    />
  )

  // 浮窗 body 是常驻 DOM（关闭只 display:none），所以这个 portal 的挂载点稳定，
  // 开/关窗不会让 ChatPane 重挂。
  return transcriptSlot ? createPortal(pane, transcriptSlot) : null
}
