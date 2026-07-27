'use client'

import { MoreHorizontal, Merge, Trash2, FileText } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import type { CloneInfo } from '@/lib/agent/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { CloneStatusBadge } from './CloneStatusBadge'
import { cn } from '@/lib/utils'

interface CloneCardGridProps {
  clones: CloneInfo[]
  loading: boolean
  showActions?: boolean
  onMerge: (clone: CloneInfo) => void
  onDelete: (clone: CloneInfo) => void
  onEnterChat?: (clone: CloneInfo) => void
  onManageFiles?: (clone: CloneInfo) => void
}

export function CloneCardGrid({ clones, loading, showActions = true, onMerge, onDelete, onEnterChat, onManageFiles }: CloneCardGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    )
  }

  if (clones.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {clones.map((clone) => (
        <div
          key={clone.name}
          className={cn(
            'rounded-xl border bg-agent-surface-raised p-4 transition-shadow hover:shadow-md',
            onEnterChat ? 'cursor-pointer' : '',
            'border-agent-divider'
          )}
          role="article"
          aria-label={`分身: ${clone.display_name}, 状态: ${clone.status}`}
          onClick={() => onEnterChat?.(clone)}
        >
          {/* Header */}
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm truncate">{clone.display_name}</h3>
                <Badge
                  variant={clone.type === 'built-in' ? 'secondary' : 'outline'}
                  className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                >
                  {clone.type === 'built-in' ? '系统' : '用户'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">{clone.name}</p>
              <CloneStatusBadge status={clone.status} />
            </div>
            {showActions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  {onManageFiles && (
                    <DropdownMenuItem onClick={() => onManageFiles(clone)}>
                      <FileText className="mr-2 h-3.5 w-3.5" />
                      文件管理
                    </DropdownMenuItem>
                  )}
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
            )}
            {!showActions && onManageFiles && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={(e) => { e.stopPropagation(); onManageFiles(clone) }}
              >
                <FileText className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Badges */}
          <div className="flex items-center gap-1 mb-2 flex-wrap">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
              {clone.memory_scope === 'shared' ? '共享记忆' : '独立记忆'}
            </Badge>
            {clone.last_active && (
              <span className="text-[10px] text-muted-foreground">
                {formatDistanceToNow(new Date(clone.last_active), { addSuffix: true, locale: zhCN })}
              </span>
            )}
          </div>

          {/* Persona summary */}
          {clone.persona && (
            <p className="mt-2 text-xs text-muted-foreground line-clamp-2 border-t border-agent-divider pt-2">
              {clone.persona.replace(/^#\s+.+\n*/, '').trim()}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
