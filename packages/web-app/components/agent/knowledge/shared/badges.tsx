'use client'

import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from '@/components/ui/hover-card'

// ─── SourceBadge ─────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  workspace_archive: { bg: 'bg-pop-cyan-soft', text: 'text-pop-ink' },
  agent_conversation: { bg: 'bg-pop-purple-soft', text: 'text-pop-ink' },
  clone_merge: { bg: 'bg-pop-cyan-soft', text: 'text-pop-ink' },
  system: { bg: 'bg-pop-idle', text: 'text-pop-dim' },
  recurring_pitfall: { bg: 'bg-pop-amber-soft', text: 'text-pop-ink' },
  knowledge_pattern: { bg: 'bg-pop-green-soft', text: 'text-pop-ink' },
  scheduler: { bg: 'bg-pop-purple-soft', text: 'text-pop-ink' },
}

const SOURCE_LABELS: Record<string, string> = {
  workspace_archive: '工作区归档',
  agent_conversation: 'Agent 对话',
  clone_merge: '分身合并',
  system: '系统',
  recurring_pitfall: '反复踩坑',
  knowledge_pattern: '知识模式',
  scheduler: '调度器',
}

interface SourceBadgeProps {
  source: string
  className?: string
}

export function SourceBadge({ source, className }: SourceBadgeProps) {
  const colors = SOURCE_COLORS[source] ?? {
    bg: 'bg-pop-idle',
    text: 'text-pop-dim',
  }
  const label = SOURCE_LABELS[source] ?? source

  return (
    <Badge
      variant="secondary"
      className={cn(
        'border-none font-normal',
        colors.bg,
        colors.text,
        className
      )}
    >
      {label}
    </Badge>
  )
}

// ─── ScopeBadge ──────────────────────────────────────────────────────────────

const SCOPE_COLORS: Record<string, { bg: string; text: string }> = {
  project: { bg: 'bg-pop-green-soft', text: 'text-pop-ink' },
  workflow: { bg: 'bg-pop-cyan-soft', text: 'text-pop-ink' },
  global: { bg: 'bg-pop-purple-soft', text: 'text-pop-ink' },
}

const SCOPE_LABELS: Record<string, string> = {
  project: '项目级',
  workflow: '工作流级',
  global: '全局',
}

interface ScopeBadgeProps {
  scope: string
  className?: string
}

export function ScopeBadge({ scope, className }: ScopeBadgeProps) {
  const colors = SCOPE_COLORS[scope] ?? {
    bg: 'bg-pop-idle',
    text: 'text-pop-dim',
  }
  const label = SCOPE_LABELS[scope] ?? scope

  return (
    <Badge
      variant="secondary"
      className={cn(
        'border-none font-normal',
        colors.bg,
        colors.text,
        className
      )}
    >
      {label}
    </Badge>
  )
}

// ─── ConflictBadge ───────────────────────────────────────────────────────────

const CONFLICT_LABELS: Record<string, string> = {
  duplicate: '重复',
  contradictory: '矛盾',
  outdated: '过时',
}

interface ConflictBadgeProps {
  conflictType: string
  details?: string
  className?: string
}

export function ConflictBadge({ conflictType, details, className }: ConflictBadgeProps) {
  const label = CONFLICT_LABELS[conflictType] ?? conflictType

  const badge = (
    <Badge
      variant="secondary"
      className={cn(
        'border-none font-normal gap-1',
        'bg-pop-amber-soft',
        'text-pop-ink',
        className
      )}
    >
      <AlertTriangle className="h-3 w-3" />
      {label}
    </Badge>
  )

  if (!details) return badge

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        {badge}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-72">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">冲突详情</p>
          <p className="text-xs text-muted-foreground leading-relaxed">{details}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
