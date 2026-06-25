'use client'

import { MessageSquare, Brain, Zap, Users, ClipboardList, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

const TAB_CONFIG = [
  { id: 'chat', label: '对话', icon: MessageSquare },
  { id: 'memory', label: '记忆', icon: Brain },
  { id: 'skill', label: 'SKILL', icon: Zap },
  { id: 'clone', label: '分身', icon: Users },
  { id: 'task', label: '任务', icon: ClipboardList },
  { id: 'config', label: '配置', icon: Settings },
] as const

interface AgentTabsProps {
  activeTab: string
  onTabChange: (tab: string) => void
}

export function AgentTabs({ activeTab, onTabChange }: AgentTabsProps) {
  return (
    <div
      className="flex items-center gap-0.5 px-4 border-b border-agent-divider bg-agent-surface-raised overflow-x-auto"
      role="tablist"
      aria-label="Agent 功能标签"
    >
      {TAB_CONFIG.map((tab) => {
        const isActive = activeTab === tab.id
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(e) => {
              const idx = TAB_CONFIG.findIndex(t => t.id === tab.id)
              if (e.key === 'ArrowRight' && idx < TAB_CONFIG.length - 1) {
                onTabChange(TAB_CONFIG[idx + 1].id)
              } else if (e.key === 'ArrowLeft' && idx > 0) {
                onTabChange(TAB_CONFIG[idx - 1].id)
              }
            }}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              isActive
                ? 'border-agent-primary text-agent-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            )}
          >
            <Icon className="h-4 w-4" />
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
