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
  workspace_archive: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300' },
  agent_conversation: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300' },
  clone_merge: { bg: 'bg-cyan-100 dark:bg-cyan-900/30', text: 'text-cyan-700 dark:text-cyan-300' },
  system: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400' },
  recurring_pitfall: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-300' },
  knowledge_pattern: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300' },
  scheduler: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-300' },
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
    bg: 'bg-gray-100 dark:bg-gray-800',
    text: 'text-gray-600 dark:text-gray-400',
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
  project: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
  workflow: { bg: 'bg-sky-100 dark:bg-sky-900/30', text: 'text-sky-700 dark:text-sky-300' },
  global: { bg: 'bg-violet-100 dark:bg-violet-900/30', text: 'text-violet-700 dark:text-violet-300' },
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
    bg: 'bg-gray-100 dark:bg-gray-800',
    text: 'text-gray-600 dark:text-gray-400',
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
        'bg-amber-100 dark:bg-amber-900/30',
        'text-amber-700 dark:text-amber-300',
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
