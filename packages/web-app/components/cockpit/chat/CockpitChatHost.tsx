'use client'

// S5 owns this file —— 全域座舱的聊天宿主。
//
// 从 CabinChatHost 抽出的会话解析 / shared / command / 事件桥（见
// components/cabin/use-cabin-chat-wiring.ts），这里只负责全域这一侧的接线：
//   · 渲染**真的** ChatPane，并把 transcript portal 进浮窗的 body；
//   · composer 通过 composerSlot portal 到底栏 54px 输入区（plans §2.4）；
//   · onTelemetry → CockpitState.reportChat（舰桥 / ticker 读它）；
//   · layerRoot = #ck12-arena（任务模块窗浮在整个舱面上，不夹在 320px 浮窗里）；
//   · **全程挂载**：浮窗 ✕/— 只改 chatWindow 状态，ChatPane 不卸载 —— 底下
//     ChatPane 的 UI 由浮窗的 display:none 隐藏，composer 已 portal 到底栏，
//     不受隐藏祖先影响。
//
// 无主会话时**不挂** ChatPane：否则回到空会话时 composer 会在第一次发送时懒建
// 一个新会话，绕开舱主对话的绑定。此时 telemetry 保持 null（舰桥显示未就绪），
// 底栏由 CockpitCommandBar 显示禁用文案。

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatPane } from '@/components/agent/chat/ChatPane'
import { useCabinContext } from '@/components/cabin/cabin-provider'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useCabinChatWiring } from '@/components/cabin/use-cabin-chat-wiring'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useChatSlot } from './chat-slots'

export interface CockpitChatHostProps {
  entryCabinId: string
}

export function CockpitChatHost({ entryCabinId }: CockpitChatHostProps) {
  const { cabinId, cabin } = useCabinContext()
  const { reportChat } = useCockpitState()
  const { setStreaming } = useCockpit()
  const transcriptSlot = useChatSlot('transcript')
  const composerSlot = useChatSlot('composer')

  const {
    sessionId, setSessionId,
    activeTask, setActiveTask,
    pendingTaskSession, setPendingTaskSession,
    command, issueCommand,
    mainSessionId, shared,
  } = useCabinChatWiring({ sidebarWidth: 0 })

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

  if (!mainSessionId) return null

  const pane = (
    <ChatPane
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
