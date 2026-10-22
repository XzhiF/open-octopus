'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAgentSessions } from '@/hooks/useAgentSessions'
import { useAgentChat } from '@/hooks/useAgentChat'
import { useSessionUsage } from '@/hooks/useSessionUsage'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { SessionList } from './SessionList'
import { ChatArea } from './ChatArea'
import { ToolCallPanel } from './ToolCallPanel'
import { KcCard, type KcCardActionCtx } from '@/components/knowledge-center/cards/registry'
import {
  parseKcCardBlocks,
  type KcCardEvent,
  type KcCompileDiffCardData,
  type KcIngestCardData,
} from '@/lib/knowledge-center/card-protocol'
import type { AgentMessage } from '@/lib/agent/types'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { PanelLeftOpen } from 'lucide-react'

export function ChatTab() {
  const {
    sessions, activeSessionId, setActiveSessionId,
    loading: sessionsLoading, createNewSession, renameSession, removeSession,
    updateSessionTitle,
  } = useAgentSessions()

  // Callback to update session title in sidebar when server auto-generates one
  const handleTitleUpdate = useCallback((sessionId: string, title: string) => {
    updateSessionTitle(sessionId, title)
  }, [updateSessionTitle])

  const {
    messages, streaming, streamContent, streamThinking, streamTimeline, isThinking, toolCalls, pendingConfirm,
    error: chatError, statusMessage, contextUsage,
    sendMessage, stopGenerate, handleConfirm, loadMessages,
  } = useAgentChat(activeSessionId, { onTitleUpdate: handleTitleUpdate })
  const sessionUsage = useSessionUsage(activeSessionId, streaming)
  // Same model aliases as the task-draft workspace (ChatArea's composer bar).
  const [model, setModel] = useState('pro')

  // ── 票10 投喂泛化：会话策展卡回流呈现 ──
  // 卡片回流原会话的普通侧宿主：Lane A fenced 块剥块渲染（注册表复用=零新卡类），
  // Lane B 覆盖层 store 直接复用 useKcFeed（开放点裁定：钮点击即时态由既有 hook
  // 承载，不新建基建）。动作钮链与知识中心同一套 REST（revert/retry=上下文无关）。
  const feed = useKcFeed({})
  const [composerSeed, setComposerSeed] = useState('')

  const { viewMessages, laneAByMsgId, laneAIds, laneAIngestById } = useMemo(() => {
    const byMsgId = new Map<string, KcCardEvent[]>()
    const ids = new Set<string>()
    const ingestById = new Map<string, KcCardEvent>()
    const vm = messages.map((m): AgentMessage => {
      if (!m.content || !m.content.includes('kc-card')) return m
      const { events, rest } = parseKcCardBlocks(m.content)
      if (events.length === 0) return m
      byMsgId.set(m.id, events)
      for (const e of events) {
        ids.add(e.id)
        if (e.kind === 'ingest') ingestById.set(e.id, e)
      }
      return { ...m, content: rest }
    })
    return { viewMessages: vm, laneAByMsgId: byMsgId, laneAIds: ids, laneAIngestById: ingestById }
  }, [messages])

  // Lane B 覆盖层回灌 Lane A 沉淀卡（与 curator-drawer withCardStates 同构的普通会话最小子集：
  // revert 态按 commit 匹配；ingest 重试后的编译镜像按同 id 取 store 新态）
  const withCardStates = useCallback((e: KcCardEvent): KcCardEvent => {
    if (e.kind === 'compile-diff') {
      const d = e.data as KcCompileDiffCardData
      if (!d.commit || d.revert || !feed.revertStates[d.commit]) return e
      return { ...e, data: { ...d, revert: feed.revertStates[d.commit] } }
    }
    if (e.kind === 'ingest') {
      const live = feed.cards.find(c => c.id === e.id)
      const lc = live?.kind === 'ingest' ? (live.data as KcIngestCardData).compile : undefined
      if (!lc) return e
      return { ...e, data: { ...(e.data as KcIngestCardData), compile: lc } }
    }
    return e
  }, [feed.revertStates, feed.cards])

  const ctx: KcCardActionCtx = useMemo(() => ({
    // 普通会话无 KC 右栏布局：开页/看 raw 类布局动作降级为无操作（回流链只产
    // ingest/compile-diff/source-summary 三类卡；其余动作钮在本宿主不可达）。
    openPage: () => {},
    openFullPage: () => {},
    openRaw: () => {},
    revert: commit => void feed.revert(commit),
    retryCompile: (cardId, rawPath) => {
      // Lane A 卡先入 store（retryCompile 需按 id 找底座；编译镜像回灌原卡）
      const ev = laneAIngestById.get(cardId)
      if (ev) feed.restore([ev])
      void feed.retryCompile(cardId, rawPath)
    },
    sayToCurator: text => setComposerSeed(text),
    adoptFinding: () => {},
    ignoreFinding: () => {},
    backfillWiki: () => {},
    dismissBackfill: () => {},
    recompilePack: () => {},
    retireCase: () => {},
  }), [feed.revert, feed.retryCompile, feed.restore, laneAIngestById])

  // 尾挂 = Lane B 新卡（重试新任务等），同 id Lane A 优先（协议两车道契约）
  const tailEvents = useMemo(
    () => feed.cards
      .filter(e => !laneAIds.has(e.id))
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map(withCardStates),
    [feed.cards, laneAIds, withCardStates],
  )

  const extras = useCallback((msg: AgentMessage) => {
    const events = laneAByMsgId.get(msg.id)
    if (!events || events.length === 0) return null
    return events.map(e => <KcCard key={e.id} event={withCardStates(e)} ctx={ctx} />)
  }, [laneAByMsgId, ctx, withCardStates])

  const tail = tailEvents.length > 0
    ? <div data-testid="chat-tab-card-tail">{tailEvents.map(e => <KcCard key={e.id} event={e} ctx={ctx} />)}</div>
    : null

  const [showToolPanel, setShowToolPanel] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  // Pending message when auto-creating a session
  const pendingMessageRef = useRef<string | null>(null)
  // Skip loadMessages for sessions we just created + sent first message to
  const loadedSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!activeSessionId) return
    if (loadedSessionIdsRef.current.has(activeSessionId)) return
    loadedSessionIdsRef.current.add(activeSessionId)
    // New session with pending message — server has 0 messages, skip load
    // to avoid wiping the optimistically-added user message
    if (pendingMessageRef.current) return
    loadMessages()
  }, [activeSessionId, loadMessages])

  // When a session is created and there's a pending message, send it
  useEffect(() => {
    if (activeSessionId && pendingMessageRef.current) {
      const msg = pendingMessageRef.current
      pendingMessageRef.current = null
      // Small delay to ensure useAgentChat has updated with new sessionId
      requestAnimationFrame(() => sendMessage(msg, { model }))
    }
  }, [activeSessionId, sendMessage, model])

  const handleSendMessage = useCallback((message: string) => {
    if (activeSessionId) {
      sendMessage(message, { model })
    } else {
      // No session — auto-create one, then send message
      pendingMessageRef.current = message
      createNewSession()
    }
  }, [activeSessionId, sendMessage, createNewSession, model])

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id)
    setMobileSidebarOpen(false)
  }

  return (
    <div className="flex h-full relative">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 border-r border-agent-divider bg-agent-surface-raised flex-col">
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          loading={sessionsLoading}
          onSelect={handleSelectSession}
          onCreate={createNewSession}
          onRename={renameSession}
          onDelete={removeSession}
        />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-72 p-0 md:hidden">
          <SessionList
            sessions={sessions}
            activeId={activeSessionId}
            loading={sessionsLoading}
            onSelect={handleSelectSession}
            onCreate={createNewSession}
            onRename={renameSession}
            onDelete={removeSession}
          />
        </SheetContent>
      </Sheet>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Mobile-only toolbar: session list trigger + active title */}
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-agent-divider bg-agent-surface-raised md:hidden">
          <div className="flex items-center">
            <Button variant="ghost" size="icon" onClick={() => setMobileSidebarOpen(true)}>
              <PanelLeftOpen className="h-5 w-5" />
            </Button>
            <span className="ml-2 text-sm font-medium truncate">
              {sessions.find(s => s.id === activeSessionId)?.title ?? '对话'}
            </span>
          </div>
        </div>

        <ChatArea
          messages={viewMessages}
          streaming={streaming}
          streamContent={streamContent}
          streamThinking={streamThinking}
          streamTimeline={streamTimeline}
          isThinking={isThinking}
          toolCalls={toolCalls}
          pendingConfirm={pendingConfirm}
          error={chatError}
          statusMessage={statusMessage}
          onSend={handleSendMessage}
          onStop={stopGenerate}
          onConfirm={handleConfirm}
          hasSession={!!activeSessionId}
          contextUsage={contextUsage}
          sessionUsage={sessionUsage}
          currentModel={model}
          onModelChange={setModel}
          showUsagePlaceholders
          composerSeed={composerSeed}
          messageExtras={extras}
          transcriptTail={tail}
        />
      </div>

      {/* Tool call panel */}
      {showToolPanel && toolCalls.length > 0 && (
        <aside className="hidden lg:block w-80 border-l border-agent-divider bg-agent-surface-raised">
          <ToolCallPanel
            toolCalls={toolCalls}
            onClose={() => setShowToolPanel(false)}
          />
        </aside>
      )}

      {/* Tool panel toggle */}
      {toolCalls.length > 0 && !showToolPanel && (
        <button
          onClick={() => setShowToolPanel(true)}
          className="hidden lg:flex absolute right-6 bottom-36 items-center gap-1 px-3 py-1.5 rounded-full bg-agent-primary text-agent-primary-foreground text-xs font-medium shadow-md hover:bg-agent-primary-hover transition-colors"
        >
          工具调用 ({toolCalls.length})
        </button>
      )}
    </div>
  )
}
