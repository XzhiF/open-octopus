'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SessionList } from '../chat/SessionList'
import { ChatArea } from '../chat/ChatArea'
import { ToolCallPanel } from '../chat/ToolCallPanel'
import { AgentChatBoundary } from '../chat/AgentChatBoundary'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { PanelLeftOpen } from 'lucide-react'
import { useAgentChat } from '@/hooks/useAgentChat'
import * as api from '@/lib/agent/api'
import type { AgentSession, CloneInfo } from '@/lib/agent/types'

interface CloneChatViewProps {
  clone: CloneInfo
  onBack: () => void
}

/**
 * Clone-specific chat view (PRD Story D3).
 *
 * Reuses the ChatTab three-column layout but scoped to a single clone's sessions.
 * Click a clone card → enter this view → see only that clone's conversations.
 */
export function CloneChatView({ clone, onBack }: CloneChatViewProps) {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const {
    messages, streaming, streamContent, toolCalls, pendingConfirm,
    error: chatError, statusMessage,
    sendMessage, stopGenerate, handleConfirm, loadMessages,
  } = useAgentChat(activeSessionId)

  const [showToolPanel, setShowToolPanel] = useState(false)

  // Fetch clone-specific sessions
  const fetchSessions = useCallback(async () => {
    try {
      setSessionsLoading(true)
      const res = await api.listSessions({ clone: clone.name, limit: 50 })
      setSessions(res.items)
      // Auto-select first session if none active
      if (res.items.length > 0 && !activeSessionId) {
        setActiveSessionId(res.items[0].id)
      }
    } catch {
      // Non-fatal — show empty state
    } finally {
      setSessionsLoading(false)
    }
  }, [clone.name, activeSessionId])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    if (activeSessionId) loadMessages()
  }, [activeSessionId, loadMessages])

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id)
    setMobileSidebarOpen(false)
  }

  const handleCreateSession = async () => {
    try {
      const session = await api.createSession({ clone_name: clone.name })
      setSessions(prev => [session, ...prev])
      setActiveSessionId(session.id)
      return session
    } catch {
      return null
    }
  }

  const handleDeleteSession = async (id: string) => {
    try {
      await api.deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeSessionId === id) {
        setActiveSessionId(sessions.length > 1 ? sessions.find(s => s.id !== id)?.id ?? null : null)
      }
    } catch {
      // Non-fatal
    }
  }

  return (
    <div className="flex h-full relative">
      {/* Desktop sidebar — clone session list */}
      <aside className="hidden md:flex w-60 border-r border-agent-divider bg-agent-surface-raised flex-col">
        {/* Back button + clone info */}
        <div className="px-3 py-2 border-b border-agent-divider">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回分身列表
          </Button>
          <div className="mt-2 px-1">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-agent-primary" />
              <span className="text-sm font-medium truncate">{clone.name}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {clone.persona_summary || '分身对话'}
            </p>
          </div>
        </div>

        {sessionsLoading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">还没有对话</p>
            <Button
              size="sm"
              className="mt-3 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
              onClick={handleCreateSession}
            >
              开始对话
            </Button>
          </div>
        ) : (
          <SessionList
            sessions={sessions}
            activeId={activeSessionId}
            loading={false}
            onSelect={handleSelectSession}
            onCreate={handleCreateSession}
            onRename={() => {}}
            onDelete={handleDeleteSession}
          />
        )}
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-72 p-0 md:hidden">
          <div className="px-3 py-2 border-b border-agent-divider">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 w-full justify-start"
              onClick={() => { setMobileSidebarOpen(false); onBack() }}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回分身列表
            </Button>
          </div>
          <SessionList
            sessions={sessions}
            activeId={activeSessionId}
            loading={sessionsLoading}
            onSelect={handleSelectSession}
            onCreate={handleCreateSession}
            onRename={() => {}}
            onDelete={handleDeleteSession}
          />
        </SheetContent>
      </Sheet>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-agent-divider bg-agent-surface-raised">
          <div className="md:hidden flex items-center">
            <Button variant="ghost" size="icon" onClick={() => setMobileSidebarOpen(true)}>
              <PanelLeftOpen className="h-5 w-5" />
            </Button>
            <span className="ml-2 text-sm font-medium truncate">
              {clone.name} — {sessions.find(s => s.id === activeSessionId)?.title ?? '对话'}
            </span>
          </div>
          <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
            <span>分身: {clone.name}</span>
            <span>·</span>
            <span>{sessions.length} 个对话</span>
          </div>
          <div />
        </div>

        <AgentChatBoundary context="agent" />

        <ChatArea
          messages={messages}
          streaming={streaming}
          streamContent={streamContent}
          toolCalls={toolCalls}
          pendingConfirm={pendingConfirm}
          error={chatError}
          statusMessage={statusMessage}
          onSend={sendMessage}
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
          className="hidden lg:flex absolute right-4 bottom-20 items-center gap-1 px-3 py-1.5 rounded-full bg-agent-primary text-agent-primary-foreground text-xs font-medium shadow-md hover:bg-agent-primary-hover transition-colors"
        >
          工具调用 ({toolCalls.length})
        </button>
      )}
    </div>
  )
}
