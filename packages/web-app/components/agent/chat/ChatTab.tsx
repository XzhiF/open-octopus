'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAgentSessions } from '@/hooks/useAgentSessions'
import { useAgentChat } from '@/hooks/useAgentChat'
import { SessionList } from './SessionList'
import { ChatArea } from './ChatArea'
import { ToolCallPanel } from './ToolCallPanel'
import { AgentChatBoundary } from './AgentChatBoundary'
import { PerspectiveIndicator } from './PerspectiveIndicator'
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
    messages, streaming, streamContent, streamThinking, isThinking, toolCalls, pendingConfirm,
    error: chatError, statusMessage,
    sendMessage, stopGenerate, handleConfirm, loadMessages,
  } = useAgentChat(activeSessionId, { onTitleUpdate: handleTitleUpdate })

  const [showToolPanel, setShowToolPanel] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [activeClone, setActiveClone] = useState<string | null>(null)

  // Pending message when auto-creating a session
  const pendingMessageRef = useRef<string | null>(null)
  // Skip loadMessages for sessions we just created + sent first message to
  const loadedSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!activeSessionId) return
    if (loadedSessionIdsRef.current.has(activeSessionId)) return
    loadedSessionIdsRef.current.add(activeSessionId)
    loadMessages()
  }, [activeSessionId, loadMessages])

  // When a session is created and there's a pending message, send it
  useEffect(() => {
    if (activeSessionId && pendingMessageRef.current) {
      const msg = pendingMessageRef.current
      pendingMessageRef.current = null
      // Small delay to ensure useAgentChat has updated with new sessionId
      requestAnimationFrame(() => sendMessage(msg))
    }
  }, [activeSessionId, sendMessage])

  const handleSendMessage = useCallback((message: string) => {
    if (activeSessionId) {
      sendMessage(message)
    } else {
      // No session — auto-create one, then send message
      pendingMessageRef.current = message
      createNewSession()
    }
  }, [activeSessionId, sendMessage, createNewSession])

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
        {/* Toolbar with perspective indicator */}
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-agent-divider bg-agent-surface-raised">
          <div className="md:hidden flex items-center">
            <Button variant="ghost" size="icon" onClick={() => setMobileSidebarOpen(true)}>
              <PanelLeftOpen className="h-5 w-5" />
            </Button>
            <span className="ml-2 text-sm font-medium truncate">
              {sessions.find(s => s.id === activeSessionId)?.title ?? '对话'}
            </span>
          </div>
          <div className="hidden md:flex items-center" />
          <PerspectiveIndicator
            activeClone={activeClone}
            onSelectClone={setActiveClone}
          />
        </div>

        {/* Agent/Workspace boundary description */}
        <AgentChatBoundary context="agent" />

        <ChatArea
          messages={messages}
          streaming={streaming}
          streamContent={streamContent}
          streamThinking={streamThinking}
          isThinking={isThinking}
          toolCalls={toolCalls}
          pendingConfirm={pendingConfirm}
          error={chatError}
          statusMessage={statusMessage}
          onSend={handleSendMessage}
          onStop={stopGenerate}
          onConfirm={handleConfirm}
          hasSession={!!activeSessionId}
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
