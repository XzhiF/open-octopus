# Ticket 06: Frontend Three-Column Layout

## Summary
创建三栏布局组件，整合文件树、文件内容、Chat 面板。

## Acceptance Criteria
- [ ] 三栏布局：文件树 (240px) | 文件内容 (flex-1) | Chat (400px)
- [ ] 文件树可折叠（mobile 默认隐藏）
- [ ] 选中文件时中间面板显示内容
- [ ] Chat 面板复用现有 ChatArea 组件
- [ ] 响应式布局（lg 断点）
- [ ] 组件测试覆盖

## Implementation

### File: `packages/web-app/components/agent/clone/CloneDetailView.tsx` (NEW)

```typescript
'use client'

import { useState, useEffect, useCallback } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CloneFileTree } from './CloneFileTree'
import { CloneFileContent } from './CloneFileContent'
import { ChatArea } from '../chat/ChatArea'
import { useAgentChat } from '@/hooks/useAgentChat'
import { useAgentSessions } from '@/hooks/useAgentSessions'
import { api } from '@/lib/agent/api'
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
    activeSession,
    setActiveSessionId,
    createSession,
    deleteSession,
  } = useAgentSessions({ clone: clone.name })

  const {
    messages,
    sendMessage,
    stopGeneration,
    pendingConfirm,
    resolveConfirm,
    isStreaming,
  } = useAgentChat({
    sessionId: activeSession?.id ?? null,
    context: 'agent',
  })

  // Load file tree
  const loadFiles = useCallback(async () => {
    try {
      const res = await api.listCloneFiles(clone.name, true)
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
    if (sessions.length === 0 && !activeSession) {
      createSession()
    } else if (sessions.length > 0 && !activeSession) {
      setActiveSessionId(sessions[0].id)
    }
  }, [sessions, activeSession, createSession, setActiveSessionId])

  const handleCreateFile = async (parentPath: string) => {
    const name = prompt('文件名：')
    if (!name) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    await api.updateCloneFile(clone.name, fullPath, { content: '' })
    loadFiles()
  }

  const handleCreateDirectory = async (parentPath: string) => {
    const name = prompt('目录名：')
    if (!name) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    await api.createCloneDirectory(clone.name, fullPath)
    loadFiles()
  }

  const handleDeleteFile = async (file: FileInfo) => {
    if (!confirm(`删除 ${file.name}？`)) return
    await api.deleteCloneFile(clone.name, file.path)
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
              onSend={sendMessage}
              onStop={stopGeneration}
              isStreaming={isStreaming}
              pendingConfirm={pendingConfirm}
              onResolveConfirm={resolveConfirm}
              sessions={sessions}
              activeSession={activeSession}
              onSelectSession={setActiveSessionId}
              onCreateSession={createSession}
              onDeleteSession={deleteSession}
            />
          </div>
        )}
      </div>
    </div>
  )
}
```

### Tests: `packages/web-app/components/agent/clone/__tests__/CloneDetailView.test.tsx` (NEW)

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CloneDetailView } from '../CloneDetailView'
import type { CloneInfo } from '@/lib/agent/types'

vi.mock('@/lib/agent/api', () => ({
  api: {
    listCloneFiles: vi.fn().mockResolvedValue({ files: [] }),
    getCloneFile: vi.fn(),
    updateCloneFile: vi.fn(),
    deleteCloneFile: vi.fn(),
    createCloneDirectory: vi.fn(),
  },
}))

vi.mock('@/hooks/useAgentChat', () => ({
  useAgentChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    stopGeneration: vi.fn(),
    pendingConfirm: null,
    resolveConfirm: vi.fn(),
    isStreaming: false,
  }),
}))

vi.mock('@/hooks/useAgentSessions', () => ({
  useAgentSessions: () => ({
    sessions: [{ id: '1', title: 'Test' }],
    activeSession: { id: '1', title: 'Test' },
    setActiveSessionId: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
  }),
}))

describe('CloneDetailView', () => {
  const mockClone: CloneInfo = {
    name: 'test-clone',
    display_name: '测试分身',
    type: 'user',
    persona: '',
    skills: [],
    memory_scope: 'isolated',
    status: 'idle',
  }

  it('renders three-column layout', () => {
    render(<CloneDetailView clone={mockClone} onBack={() => {}} />)
    expect(screen.getByText('测试分身')).toBeInTheDocument()
  })

  it('shows clone name in toolbar', () => {
    render(<CloneDetailView clone={mockClone} onBack={() => {}} />)
    expect(screen.getByText('测试分身')).toBeInTheDocument()
  })
})
```

## Verification
```bash
# Run component tests
pnpm test packages/web-app/components/agent/clone/__tests__/CloneDetailView.test.tsx

# Visual test: open browser, navigate to clone detail view
```
