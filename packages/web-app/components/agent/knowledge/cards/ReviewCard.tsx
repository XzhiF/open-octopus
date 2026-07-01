'use client'

/**
 * Traceability: P-08 × US-17, US-24 × TC-022, TC-032
 * In-chat review card for pending rules with approve/reject/defer/edit actions
 */

import { useState, useCallback } from 'react'
import { Check, X, Pause, Edit3, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SourceBadge, ScopeBadge, ConflictBadge } from '../shared/badges'
import { ActionConfirmCard } from './ActionConfirmCard'

interface ReviewCardProps {
  item: {
    id: string
    type: 'rule' | 'skill'
    content: string
    source: string
    sourceLabel: string
    targetFile: string
    scope: string
    conflicts: Array<{ existingRule: string; conflictType: string }> | null
    confidence: number
  }
  onAction: (id: string, action: 'approve' | 'reject' | 'defer' | 'edit') => void
  onDiscuss?: (item: ReviewCardProps['item']) => void
  disabled?: boolean
}

type ActionType = 'approve' | 'reject' | 'defer' | 'edit'

const ACTION_CONFIRM_MAP: Record<ActionType, 'approved' | 'rejected' | 'deferred' | 'edited'> = {
  approve: 'approved',
  reject: 'rejected',
  defer: 'deferred',
  edit: 'edited',
}

export function ReviewCard({ item, onAction, onDiscuss, disabled }: ReviewCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [takenAction, setTakenAction] = useState<ActionType | null>(null)

  const handleAction = useCallback(
    (action: ActionType) => {
      if (disabled || takenAction) return
      setTakenAction(action)
      onAction(item.id, action)
    },
    [disabled, takenAction, item.id, onAction],
  )

  const needsTruncation = item.content.length > 120
  const isDisabled = disabled || takenAction !== null

  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-colors',
        isDisabled
          ? 'border-agent-divider bg-agent-surface opacity-75'
          : 'border-agent-divider bg-agent-surface',
      )}
    >
      {/* Header */}
      <div className="flex items-center flex-wrap gap-1.5 mb-2.5">
        <span className="text-xs font-medium text-muted-foreground">
          #{item.id.slice(-4)}
        </span>
        <SourceBadge source={item.source} />
        <ScopeBadge scope={item.scope} />
        {item.sourceLabel && (
          <span className="text-xs text-muted-foreground">{item.sourceLabel}</span>
        )}
      </div>

      {/* Content */}
      <div className="mb-3">
        <p
          className={cn(
            'text-sm leading-relaxed text-foreground',
            !expanded && 'line-clamp-3',
          )}
        >
          {item.content}
        </p>
        {needsTruncation && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-0.5 text-xs text-knowledge-primary hover:underline mt-1"
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3" />
                收起
              </>
            ) : (
              <>
                <ChevronDown className="size-3" />
                展开全部
              </>
            )}
          </button>
        )}
      </div>

      {/* Conflicts */}
      {item.conflicts && item.conflicts.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 mb-3">
          {item.conflicts.map((conflict, idx) => (
            <ConflictBadge
              key={idx}
              conflictType={conflict.conflictType}
              details={conflict.existingRule}
            />
          ))}
        </div>
      )}

      {/* Action result or action buttons */}
      {takenAction ? (
        <ActionConfirmCard action={ACTION_CONFIRM_MAP[takenAction]} />
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs h-7 px-2 text-agent-success hover:text-agent-success"
            onClick={() => handleAction('approve')}
            disabled={isDisabled}
          >
            <Check className="size-3" />
            纳入
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs h-7 px-2 text-agent-error hover:text-agent-error"
            onClick={() => handleAction('reject')}
            disabled={isDisabled}
          >
            <X className="size-3" />
            跳过
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs h-7 px-2"
            onClick={() => handleAction('edit')}
            disabled={isDisabled}
          >
            <Edit3 className="size-3" />
            修改
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs h-7 px-2"
            onClick={() => handleAction('defer')}
            disabled={isDisabled}
          >
            <Pause className="size-3" />
            暂缓
          </Button>
        </div>
      )}
    </div>
  )
}
