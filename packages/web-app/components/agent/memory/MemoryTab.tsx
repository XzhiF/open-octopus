'use client'

import { useState, useEffect } from 'react'
import { Brain, Calendar, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentMemory } from '@/hooks/useAgentMemory'
import type { MemoryLayer } from '@/lib/agent/types'
import { LongTermEditor } from './LongTermEditor'
import { DailyBrowser } from './DailyBrowser'
import { SessionSearch } from './SessionSearch'

const SUB_TABS = [
  { id: 'long-term' as MemoryLayer, label: '长期记忆', icon: Brain },
  { id: 'daily' as MemoryLayer, label: '工作记忆', icon: Calendar },
  { id: 'session' as MemoryLayer, label: '会话记忆', icon: Search },
] as const

export function MemoryTab() {
  const [activeLayer, setActiveLayer] = useState<MemoryLayer>('long-term')
  const { content, loading, error, fetchMemory } = useAgentMemory()

  useEffect(() => {
    fetchMemory(activeLayer)
  }, [activeLayer, fetchMemory])

  return (
    <div className="flex h-full">
      {/* Sub-navigation */}
      <nav className="w-48 border-r border-agent-divider bg-agent-surface-raised p-3 hidden sm:block">
        <div className="space-y-1">
          {SUB_TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeLayer === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveLayer(tab.id)}
                className={cn(
                  'flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-agent-primary-light text-agent-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </nav>

      {/* Mobile sub-tabs */}
      <div className="sm:hidden flex items-center gap-1 px-3 py-2 border-b border-agent-divider overflow-x-auto">
        {SUB_TABS.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveLayer(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
                activeLayer === tab.id
                  ? 'bg-agent-primary text-agent-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
            {error}
          </div>
        )}

        {activeLayer === 'long-term' && (
          <LongTermEditor content={content} loading={loading} />
        )}
        {activeLayer === 'daily' && (
          <DailyBrowser content={content} loading={loading} />
        )}
        {activeLayer === 'session' && (
          <SessionSearch />
        )}
      </div>
    </div>
  )
}
