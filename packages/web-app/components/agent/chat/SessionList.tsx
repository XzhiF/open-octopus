'use client'

import { useState } from 'react'
import { Plus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { AgentSession } from '@/lib/agent/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../shared/ConfirmDialog'

interface SessionListProps {
  sessions: AgentSession[]
  activeId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export function SessionList({ sessions, activeId, loading, onSelect, onCreate, onRename, onDelete }: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const handleStartRename = (session: AgentSession) => {
    setEditingId(session.id)
    setEditTitle(session.title)
  }

  const handleConfirmRename = async () => {
    if (editingId && editTitle.trim()) {
      await onRename(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-agent-divider">
        <Button
          onClick={onCreate}
          variant="outline"
          className="w-full justify-start gap-2 border-agent-primary/20 text-agent-primary hover:bg-agent-primary-light"
        >
          <Plus className="h-4 w-4" />
          新会话
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <nav aria-label="会话列表" className="p-2 space-y-0.5">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group flex items-center rounded-md px-3 py-2 text-sm cursor-pointer transition-colors',
                activeId === session.id
                  ? 'bg-agent-primary-light text-agent-primary'
                  : 'hover:bg-accent text-foreground'
              )}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(session.id) }}
            >
              <div className="flex-1 min-w-0">
                {editingId === session.id ? (
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={handleConfirmRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="w-full bg-transparent border-b border-agent-primary outline-none text-sm"
                    maxLength={200}
                  />
                ) : (
                  <span className="truncate block">{session.title}</span>
                )}
                {session.last_message_at && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(session.last_message_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 h-7 w-7 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleStartRename(session)}>
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setDeleteTarget(session.id)}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">暂无会话</p>
          )}
        </nav>
      </ScrollArea>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="删除会话"
        description="删除后无法恢复，确认删除此会话？"
        confirmLabel="删除"
        variant="destructive"
        onConfirm={() => { if (deleteTarget) { onDelete(deleteTarget); setDeleteTarget(null) } }}
      />
    </div>
  )
}
