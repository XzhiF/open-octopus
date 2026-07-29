'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { CloneFileTree } from './CloneFileTree'
import { CloneFileContent } from './CloneFileContent'
import { ChatArea } from '../chat/ChatArea'
import { SessionHeader } from './SessionHeader'
import { useAgentChat, type UseAgentChatApiOverride } from '@/hooks/useAgentChat'
import {
  listCloneFiles,
  updateCloneFile,
  createCloneDirectory,
  deleteCloneFile,
  listCloneSessions,
  createCloneSession,
  getCloneSession,
  cloneChatStream,
  stopCloneChat,
} from '@/lib/agent/api'
import type { CloneInfo, FileInfo, AgentSession } from '@/lib/agent/types'

interface CloneDetailViewProps {
  clone: CloneInfo
  onBack: () => void
}

export function CloneDetailView({ clone, onBack }: CloneDetailViewProps) {
  // ── File tree state ──
  const [files, setFiles] = useState<FileInfo[]>([])
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
  const [showFileTree, setShowFileTree] = useState(true)
  const [showChat, setShowChat] = useState(true)

  // ── Clone-scoped session state ──
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const activeSessionIdRef = useRef(activeSessionId)
  activeSessionIdRef.current = activeSessionId

  // ── Clone-specific API overrides for useAgentChat ──
  const cloneName = clone.name
  const chatApiOverrides: UseAgentChatApiOverride = {
    getSession: (id, query) => getCloneSession(cloneName, id, query),
    chatStream: (id, message) => cloneChatStream(cloneName, id, message),
    stopChat: (id) => stopCloneChat(cloneName, id),
  }

  const handleTitleUpdate = useCallback((sessionId: string, title: string) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s))
  }, [])

  const {
    messages,
    streaming,
    streamContent,
    streamThinking,
    isThinking,
    toolCalls,
    pendingConfirm,
    error: chatError,
    statusMessage,
    sendMessage,
    stopGenerate,
    handleConfirm,
    loadMessages,
  } = useAgentChat(activeSessionId, { api: chatApiOverrides, onTitleUpdate: handleTitleUpdate })

  // ── Load file tree ──
  const loadFiles = useCallback(async () => {
    try {
      const res = await listCloneFiles(clone.name, true)
      setFiles(res.files)
    } catch {
      setFiles([])
    }
  }, [clone.name])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // ── Fetch clone-specific sessions; auto-create if none exist ──
  const fetchSessions = useCallback(async () => {
    try {
      setSessionsLoading(true)
      const res = await listCloneSessions(clone.name, { limit: 50 })
      const items = res.sessions ?? []
      setSessions(items)
      if (items.length > 0 && !activeSessionIdRef.current) {
        setActiveSessionId(items[0].id)
      } else if (items.length === 0 && !activeSessionIdRef.current) {
        const session = await createCloneSession(clone.name)
        setSessions([session])
        setActiveSessionId(session.id)
      }
    } catch {
      // Non-fatal
    } finally {
      setSessionsLoading(false)
    }
  }, [clone.name])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // ── Load messages when session changes ──
  useEffect(() => {
    if (activeSessionId) loadMessages()
  }, [activeSessionId, loadMessages])

  // ── Session CRUD ──
  const handleCreateSession = useCallback(async () => {
    try {
      const session = await createCloneSession(clone.name)
      setSessions(prev => [session, ...prev])
      setActiveSessionId(session.id)
    } catch {
      // Non-fatal
    }
  }, [clone.name])

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id)
  }, [])

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    // Clone sessions don't have a rename API yet — local only
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s))
  }, [])

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      // Clone sessions don't have a delete API yet — remove from local list
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeSessionId === id) {
        const remaining = sessions.filter(s => s.id !== id)
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
      }
    } catch {
      // Non-fatal
    }
  }, [activeSessionId, sessions])

  // ── File operations ──
  const handleCreateFile = async (parentPath: string) => {
    const name = prompt('文件名：')
    if (!name) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    await updateCloneFile(clone.name, fullPath, { content: '' })
    loadFiles()
  }

  const handleCreateDirectory = async (parentPath: string) => {
    const name = prompt('目录名：')
    if (!name) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    await createCloneDirectory(clone.name, fullPath)
    loadFiles()
  }

  const handleDeleteFile = async (file: FileInfo) => {
    if (!confirm(`删除 ${file.name}？`)) return
    await deleteCloneFile(clone.name, file.path)
    if (selectedFile?.path === file.path) {
      setSelectedFile(null)
    }
    loadFiles()
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← 返回
          </Button>
          <span className="text-sm font-medium">{clone.display_name}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowFileTree(!showFileTree)}
          >
            <PanelLeft className={`h-4 w-4 ${showFileTree ? '' : 'opacity-50'}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowChat(!showChat)}
          >
            <PanelRight className={`h-4 w-4 ${showChat ? '' : 'opacity-50'}`} />
          </Button>
        </div>
      </div>

      {/* Resizable three-column layout */}
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* File Tree */}
        {showFileTree && (
          <>
            <ResizablePanel
              defaultSize={20}
              minSize={10}
              maxSize={40}
              collapsible
              collapsedSize={0}
              className="overflow-hidden"
            >
              <div className="h-full overflow-hidden flex flex-col">
                <CloneFileTree
                  files={files}
                  selectedFile={selectedFile}
                  onSelectFile={setSelectedFile}
                  onCreateFile={handleCreateFile}
                  onCreateDirectory={handleCreateDirectory}
                  onDeleteFile={handleDeleteFile}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle className="border-agent-divider" />
          </>
        )}

        {/* File Content */}
        <ResizablePanel defaultSize={showChat ? 45 : 80} minSize={20} className="overflow-hidden">
          <div className="h-full overflow-hidden">
            <CloneFileContent
              cloneName={clone.name}
              file={selectedFile}
              onSaved={loadFiles}
            />
          </div>
        </ResizablePanel>

        {/* Chat Panel: Session List + ChatArea */}
        {showChat && (
          <>
            <ResizableHandle className="border-agent-divider" />
            <ResizablePanel
              defaultSize={35}
              minSize={20}
              maxSize={60}
              collapsible
              collapsedSize={0}
              className="overflow-hidden"
            >
              <div className="h-full overflow-hidden flex flex-col">
                <SessionHeader
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onNewSession={handleCreateSession}
                  onSelectSession={handleSelectSession}
                  onRenameSession={handleRenameSession}
                  onDeleteSession={handleDeleteSession}
                />
                <div className="flex-1 flex flex-col overflow-hidden min-w-0">
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
                    onSend={sendMessage}
                    onStop={stopGenerate}
                    onConfirm={handleConfirm}
                    hasSession={!!activeSessionId}
                    currentCloneName={clone.name}
                  />
                </div>
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}
