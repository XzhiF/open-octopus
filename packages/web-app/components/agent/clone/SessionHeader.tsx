'use client'

import { useState, useRef, useEffect } from 'react'
import { Plus, MoreHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { AgentSession } from '@/lib/agent/types'

interface SessionHeaderProps {
  sessions: AgentSession[]
  activeSessionId: string | null
  onNewSession: () => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
}

export function SessionHeader({
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: SessionHeaderProps) {
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const startEditing = () => {
    if (!activeSession) return
    setEditTitle(activeSession.title || '')
    setIsEditing(true)
  }

  const saveTitle = () => {
    if (activeSession && editTitle.trim() && editTitle !== activeSession.title) {
      onRenameSession(activeSession.id, editTitle.trim())
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
    }
  }

  const title = activeSession?.title || '新会话'

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-agent-divider bg-agent-surface-raised shrink-0">
      {/* Editable title */}
      {isEditing ? (
        <Input
          ref={inputRef}
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={handleKeyDown}
          className="h-7 text-sm flex-1 bg-agent-surface-inset border-agent-divider"
        />
      ) : (
        <span
          className="text-sm font-medium truncate flex-1 cursor-pointer hover:text-agent-primary transition-colors"
          onClick={startEditing}
          title="点击编辑会话名称"
        >
          {title}
        </span>
      )}

      {/* New session */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={onNewSession}
        title="新建会话"
      >
        <Plus className="h-4 w-4" />
      </Button>

      {/* Session list dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="切换会话"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-auto">
          {sessions.length === 0 ? (
            <DropdownMenuItem disabled className="text-muted-foreground text-xs">
              暂无会话
            </DropdownMenuItem>
          ) : (
            sessions.map((session) => (
              <DropdownMenuItem
                key={session.id}
                className={`flex items-center gap-2 group ${
                  session.id === activeSessionId ? 'bg-agent-hover font-medium' : ''
                }`}
                onSelect={(e) => {
                  // Prevent close when clicking delete
                  if ((e.target as HTMLElement).closest('[data-delete]')) {
                    e.preventDefault()
                    return
                  }
                  onSelectSession(session.id)
                }}
              >
                <span className="flex-1 truncate text-sm">
                  {session.id === activeSessionId && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-agent-primary mr-1.5 align-middle" />
                  )}
                  {session.title || '新会话'}
                </span>
                <button
                  data-delete
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSession(session.id)
                  }}
                  title="删除会话"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
