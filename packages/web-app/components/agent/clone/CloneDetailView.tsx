'use client'

import { useState, useEffect, useCallback } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CloneFileTree } from './CloneFileTree'
import { CloneFileContent } from './CloneFileContent'
import { ChatArea } from '../chat/ChatArea'
import { useAgentChat } from '@/hooks/useAgentChat'
import { useAgentSessions } from '@/hooks/useAgentSessions'
import {
  listCloneFiles,
  updateCloneFile,
  createCloneDirectory,
  deleteCloneFile,
  createSession as createCloneSession,
} from '@/lib/agent/api'
import type { CloneInfo, FileInfo } from '@/lib/agent/types'

interface CloneDetailViewProps {
  clone: CloneInfo
  onBack: () => void
}

export function CloneDetailView({ clone, onBack }: CloneDetailViewProps) {
  const [files, setFiles] = useState<FileInfo[]>([])
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
  const [showFileTree, setShowFileTree] = useState(true)
  const [showChat, setShowChat] = useState(true)

  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    loading: sessionsLoading,
  } = useAgentSessions()

  const {
    messages,
    streaming,
    streamContent,
    streamThinking,
    isThinking,
    toolCalls,
    pendingConfirm,
    sendMessage,
    stopGenerate,
    handleConfirm,
  } = useAgentChat(activeSessionId)

  // Load file tree
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

  // Auto-create session if none
  useEffect(() => {
    if (!sessionsLoading && sessions.length === 0) {
      createCloneSession({ clone_name: clone.name })
    } else if (!sessionsLoading && sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[0].id)
    }
  }, [sessions, sessionsLoading, activeSessionId, clone.name, setActiveSessionId])

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

      {/* Three-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Tree */}
        {showFileTree && (
          <div className="w-60 border-r border-agent-divider overflow-hidden flex flex-col">
            <CloneFileTree
              files={files}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              onCreateFile={handleCreateFile}
              onCreateDirectory={handleCreateDirectory}
              onDeleteFile={handleDeleteFile}
            />
          </div>
        )}

        {/* File Content */}
        <div className="flex-1 overflow-hidden">
          <CloneFileContent
            cloneName={clone.name}
            file={selectedFile}
            onSaved={loadFiles}
          />
        </div>

        {/* Chat Panel */}
        {showChat && (
          <div className="w-96 border-l border-agent-divider overflow-hidden flex flex-col">
            <ChatArea
              messages={messages}
              streaming={streaming}
              streamContent={streamContent}
              streamThinking={streamThinking}
              isThinking={isThinking}
              toolCalls={toolCalls}
              pendingConfirm={pendingConfirm}
              onSend={sendMessage}
              onStop={stopGenerate}
              onConfirm={handleConfirm}
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={setActiveSessionId}
            />
          </div>
        )}
      </div>
    </div>
  )
}
