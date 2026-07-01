'use client'

import { CheckCircle, XCircle, Pause, Edit3, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ActionConfirmCardProps {
  action: 'approved' | 'rejected' | 'deferred' | 'edited' | 'generated'
  detail?: string
}

const ACTION_CONFIG = {
  approved: {
    Icon: CheckCircle,
    text: '已纳入知识库',
    className: 'text-agent-success',
  },
  rejected: {
    Icon: XCircle,
    text: '已拒绝',
    className: 'text-agent-error',
  },
  deferred: {
    Icon: Pause,
    text: '已暂缓',
    className: 'text-agent-warn',
  },
  edited: {
    Icon: Edit3,
    text: '已修改',
    className: 'text-agent-info',
  },
  generated: {
    Icon: Zap,
    text: 'Skill 已提交审核',
    className: 'text-agent-accent',
  },
} as const

export function ActionConfirmCard({ action, detail }: ActionConfirmCardProps) {
  const config = ACTION_CONFIG[action]
  const { Icon, text, className } = config

  return (
    <div
      className={cn(
        'inline-flex flex-col gap-0.5 rounded-md border border-agent-divider bg-agent-surface px-3 py-2',
      )}
    >
      <div className={cn('flex items-center gap-1.5 text-sm font-medium', className)}>
        <Icon className="size-4 shrink-0" />
        <span>{text}</span>
      </div>
      {detail && (
        <p className="text-xs text-muted-foreground pl-5.5">{detail}</p>
      )}
    </div>
  )
}
