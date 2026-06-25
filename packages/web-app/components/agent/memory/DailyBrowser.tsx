'use client'

import { useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { MemoryContent } from '@/lib/agent/types'

interface DailyBrowserProps {
  content: MemoryContent | MemoryContent[] | null
  loading: boolean
}

export function DailyBrowser({ content, loading }: DailyBrowserProps) {
  const items = Array.isArray(content) ? content : content ? [content] : []
  const [selectedDate, setSelectedDate] = useState<string | null>(
    items[0]?.date ?? null
  )

  const selectedContent = items.find(item => item.date === selectedDate)

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-4">工作记忆</h2>
        <p className="text-sm text-muted-foreground">
          还没有工作记忆。Agent 每天会自动记录工作摘要。
        </p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-4">工作记忆</h2>

      {/* Date selector */}
      <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-2">
        <CalendarIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        {items.map((item, i) => (
          <button
            key={item.date ?? i}
            onClick={() => setSelectedDate(item.date ?? null)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
              selectedDate === item.date
                ? 'bg-agent-primary text-agent-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'
            )}
          >
            {item.date}
          </button>
        ))}
      </div>

      {/* Content */}
      {selectedContent && (
        <div className="rounded-lg border border-agent-divider bg-agent-surface-inset p-4 prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
            {selectedContent.content}
          </pre>
        </div>
      )}
    </div>
  )
}
