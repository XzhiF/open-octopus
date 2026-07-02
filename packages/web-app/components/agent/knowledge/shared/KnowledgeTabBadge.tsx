'use client'

import { cn } from '@/lib/utils'

interface KnowledgeTabBadgeProps {
  count: number
}

export function KnowledgeTabBadge({ count }: KnowledgeTabBadgeProps) {
  if (count === 0) return null

  const display = count > 99 ? '99+' : count

  return (
    <span
      key={count}
      className={cn(
        'bg-agent-error text-white text-[10px] rounded-full',
        'min-w-[18px] h-[18px] flex items-center justify-center',
        'animate-[knowledge-badge-pulse_300ms_ease-in-out]',
      )}
    >
      {display}
    </span>
  )
}
