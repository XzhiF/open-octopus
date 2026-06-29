'use client'

import { useState, useCallback } from 'react'
import { Zap, Check, X, Edit3, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ActionConfirmCard } from './ActionConfirmCard'

interface SkillProposalCardProps {
  skill: {
    skillName: string
    category: string
    content: string
    confidence: number
  }
  onAction: (action: 'generate' | 'reject' | 'adjust') => void
  onAdjust?: (feedback: string) => void
  disabled?: boolean
}

type ActionType = 'generate' | 'reject' | 'adjust'

const ACTION_CONFIRM_MAP: Record<ActionType, 'generated' | 'rejected' | 'edited'> = {
  generate: 'generated',
  reject: 'rejected',
  adjust: 'edited',
}

export function SkillProposalCard({ skill, onAction, onAdjust, disabled }: SkillProposalCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [takenAction, setTakenAction] = useState<ActionType | null>(null)
  const [adjustMode, setAdjustMode] = useState(false)
  const [feedback, setFeedback] = useState('')

  const handleAction = useCallback(
    (action: ActionType) => {
      if (disabled || takenAction) return

      if (action === 'adjust') {
        setAdjustMode(true)
        return
      }

      setTakenAction(action)
      onAction(action)
    },
    [disabled, takenAction, onAction],
  )

  const handleAdjustSubmit = useCallback(() => {
    if (!feedback.trim()) return
    setTakenAction('adjust')
    onAction('adjust')
    onAdjust?.(feedback.trim())
  }, [feedback, onAction, onAdjust])

  const needsTruncation = skill.content.length > 120
  const isDisabled = disabled || takenAction !== null
  const confidencePercent = Math.round(skill.confidence * 100)

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
      <div className="flex items-center gap-2 mb-2.5">
        <Zap className="size-4 text-knowledge-primary shrink-0" />
        <span className="text-sm font-medium text-foreground">{skill.skillName}</span>
        <Badge variant="secondary" className="border-none font-normal text-xs">
          {skill.category}
        </Badge>
        <span className="text-xs text-muted-foreground ml-auto">
          {confidencePercent}%
        </span>
      </div>

      {/* Content */}
      <div className="mb-3">
        <p
          className={cn(
            'text-sm leading-relaxed text-foreground',
            !expanded && 'line-clamp-3',
          )}
        >
          {skill.content}
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

      {/* Adjust mode: textarea + submit */}
      {adjustMode && !takenAction && (
        <div className="mb-3 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="描述你希望如何调整这个 Skill..."
            className={cn(
              'w-full min-h-[80px] rounded-md border border-agent-divider bg-background px-3 py-2',
              'text-sm placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-knowledge-primary/50',
              'resize-y',
            )}
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="gap-1.5 text-xs h-7 px-3 bg-knowledge-primary hover:bg-knowledge-primary-hover text-knowledge-primary-foreground"
              onClick={handleAdjustSubmit}
              disabled={!feedback.trim()}
            >
              提交
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 px-2"
              onClick={() => {
                setAdjustMode(false)
                setFeedback('')
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {/* Action result or action buttons */}
      {takenAction ? (
        <ActionConfirmCard action={ACTION_CONFIRM_MAP[takenAction]} />
      ) : (
        !adjustMode && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2 text-agent-success hover:text-agent-success"
              onClick={() => handleAction('generate')}
              disabled={isDisabled}
            >
              <Check className="size-3" />
              生成
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2 text-agent-error hover:text-agent-error"
              onClick={() => handleAction('reject')}
              disabled={isDisabled}
            >
              <X className="size-3" />
              不需要
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7 px-2"
              onClick={() => handleAction('adjust')}
              disabled={isDisabled}
            >
              <Edit3 className="size-3" />
              调整
            </Button>
          </div>
        )
      )}
    </div>
  )
}
