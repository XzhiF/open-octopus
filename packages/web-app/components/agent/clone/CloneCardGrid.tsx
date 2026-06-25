'use client'

import { MoreHorizontal, Merge, Trash2, AlertTriangle } from 'lucide-react'
import type { CloneInfo } from '@/lib/agent/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CloneStatusBadge } from './CloneStatusBadge'
import { cn } from '@/lib/utils'

interface CloneCardGridProps {
  clones: CloneInfo[]
  loading: boolean
  onMerge: (clone: CloneInfo) => void
  onDelete: (clone: CloneInfo) => void
  onEnterChat?: (clone: CloneInfo) => void
}

export function CloneCardGrid({ clones, loading, onMerge, onDelete, onEnterChat }: CloneCardGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {clones.map((clone) => (
        <div
          key={clone.name}
          className={cn(
            'rounded-xl border bg-agent-surface-raised p-4 transition-shadow hover:shadow-md',
            onEnterChat ? 'cursor-pointer' : '',
            !clone.workspace_exists
              ? 'border-agent-warn/50'
              : 'border-agent-divider'
          )}
          role="article"
          aria-label={`分身: ${clone.name}, 状态: ${clone.status}`}
          onClick={() => onEnterChat?.(clone)}
        >
          {/* Header */}
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="font-semibold text-sm">{clone.name}</h3>
              <CloneStatusBadge status={clone.status} />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => onMerge(clone)} disabled={clone.status === 'executing'}>
                  <Merge className="mr-2 h-3.5 w-3.5" />
                  合并
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => onDelete(clone)} disabled={clone.status === 'executing'}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Workspace warning */}
          {!clone.workspace_exists && (
            <div className="flex items-center gap-1.5 mb-2 text-xs text-agent-warn">
              <AlertTriangle className="h-3.5 w-3.5" />
              Workspace 丢失
            </div>
          )}

          {/* Details */}
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>工作空间</span>
              <span className="font-mono">{clone.workspace_ref.workspace_name}</span>
            </div>
            <div className="flex justify-between">
              <span>最后活跃</span>
              <span>{new Date(clone.last_active_at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>

          {/* Persona summary */}
          {clone.persona_summary && (
            <p className="mt-3 text-xs text-muted-foreground line-clamp-2 border-t border-agent-divider pt-2">
              {clone.persona_summary}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
