'use client'

import { useState, useCallback } from 'react'
import { BookOpen, Zap, Edit3, MessageCircle, Pause, X, Check } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { SourceBadge, ScopeBadge, ConflictBadge } from '../shared/badges'
import type { PendingItem } from '@/lib/knowledge/types'

interface ReviewItemCardProps {
  item: PendingItem
  isSelected: boolean
  onToggleSelect: (id: string) => void
  onAction: (id: string, action: string) => void
  onDiscuss?: (item: PendingItem) => void
}

export function ReviewItemCard({
  item,
  isSelected,
  onToggleSelect,
  onAction,
  onDiscuss,
}: ReviewItemCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const handleAction = useCallback(
    async (action: string) => {
      setActionLoading(action)
      try {
        await onAction(item.id, action)
      } finally {
        setActionLoading(null)
      }
    },
    [item.id, onAction],
  )

  const TypeIcon = item.type === 'skill' ? Zap : BookOpen
  const needsTruncation = item.content.length > 120

  return (
    <article
      aria-label={`待审项目：${item.content.slice(0, 60)}`}
      className={cn(
        'rounded-lg border transition-colors',
        isSelected
          ? 'border-l-2 border-l-knowledge-primary border-knowledge-primary/30 bg-knowledge-primary-light/30'
          : 'border-agent-divider bg-agent-surface',
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Checkbox */}
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(item.id)}
          aria-label={`选择此待审项目`}
          className="mt-1 shrink-0"
        />

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Type icon + content */}
          <div className="flex items-start gap-2">
            <TypeIcon className="h-4 w-4 text-knowledge-primary shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p
                className={cn(
                  'text-sm leading-relaxed text-foreground',
                  !expanded && 'line-clamp-2',
                )}
              >
                {item.content}
              </p>
              {needsTruncation && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-xs text-knowledge-primary hover:underline mt-0.5"
                >
                  {expanded ? '收起' : '展开'}
                </button>
              )}
            </div>
          </div>

          {/* Badges row */}
          <div className="flex items-center flex-wrap gap-1.5">
            <SourceBadge source={item.source} />
            <ScopeBadge scope={item.scope} />
            {item.sourceLabel && (
              <span className="text-xs text-muted-foreground">
                {item.sourceLabel}
              </span>
            )}
            {item.conflicts?.map((conflict, idx) => (
              <ConflictBadge
                key={idx}
                conflictType={conflict.conflictType}
                details={`${conflict.existingRule} (${conflict.existingFile})`}
              />
            ))}
          </div>

          {/* Action buttons */}
          <div
            role="toolbar"
            aria-label="审核操作"
            className="flex items-center gap-1.5 flex-wrap"
          >
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2"
              onClick={() => handleAction('edit')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'edit' ? (
                <Spinner className="size-3" />
              ) : (
                <Edit3 className="size-3" aria-hidden="true" />
              )}
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2"
              onClick={() => onDiscuss?.(item)}
              disabled={actionLoading !== null}
            >
              <MessageCircle className="size-3" aria-hidden="true" />
              讨论
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2"
              onClick={() => handleAction('defer')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'defer' ? (
                <Spinner className="size-3" />
              ) : (
                <Pause className="size-3" aria-hidden="true" />
              )}
              暂缓
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2 text-agent-error hover:text-agent-error"
              onClick={() => handleAction('reject')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'reject' ? (
                <Spinner className="size-3" />
              ) : (
                <X className="size-3" aria-hidden="true" />
              )}
              拒绝
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2 text-agent-success hover:text-agent-success"
              onClick={() => handleAction('approve')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'approve' ? (
                <Spinner className="size-3" />
              ) : (
                <Check className="size-3" aria-hidden="true" />
              )}
              纳入
            </Button>
          </div>
        </div>
      </div>
    </article>
  )
}

/** Skeleton placeholder matching ReviewItemCard layout */
export function ReviewItemCardSkeleton() {
  return (
    <div className="rounded-lg border border-agent-divider bg-agent-surface px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-1 h-4 w-4 rounded shrink-0 bg-accent animate-pulse" />
        <div className="flex-1 space-y-3">
          <div className="space-y-1.5">
            <div className="h-4 w-full rounded bg-accent animate-pulse" />
            <div className="h-4 w-3/4 rounded bg-accent animate-pulse" />
          </div>
          <div className="flex gap-2">
            <div className="h-5 w-20 rounded-full bg-accent animate-pulse" />
            <div className="h-5 w-14 rounded-full bg-accent animate-pulse" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-14 rounded bg-accent animate-pulse" />
            <div className="h-7 w-14 rounded bg-accent animate-pulse" />
            <div className="h-7 w-14 rounded bg-accent animate-pulse" />
            <div className="h-7 w-14 rounded bg-accent animate-pulse" />
            <div className="h-7 w-14 rounded bg-accent animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  )
}
