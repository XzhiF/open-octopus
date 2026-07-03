'use client'

/**
 * Traceability: P-01 × US-21 × TC-027
 * Knowledge Tab container with 4 sub-tabs (preference/project/workflow/review)
 */

import { useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { SlidersHorizontal, BookOpen, ClipboardCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { PreferenceEditor } from './PreferenceEditor'
import { ExperienceLibrary } from './ExperienceLibrary'
import { ReviewQueueList } from './review/ReviewQueueList'

const SUB_TABS = [
  { id: 'preference', label: '用户偏好', icon: SlidersHorizontal },
  { id: 'experience', label: '经验库', icon: BookOpen },
  { id: 'review', label: '审核队列', icon: ClipboardCheck },
] as const

type SubTabId = typeof SUB_TABS[number]['id']

function isValidSubTab(value: string | null): value is SubTabId {
  return value !== null && SUB_TABS.some(tab => tab.id === value)
}

export function KnowledgeTab() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { statusCounts } = useReviewQueue()
  const pendingCount = statusCounts.all

  const [activeSub, setActiveSub] = useState<SubTabId>(() => {
    const sub = searchParams.get('sub')
    return isValidSubTab(sub) ? sub : 'preference'
  })

  const handleSubChange = (id: SubTabId) => {
    setActiveSub(id)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', 'knowledge')
    url.searchParams.set('sub', id)
    router.replace(url.toString())
  }

  return (
    <div className="flex h-full">
      {/* Desktop sub-navigation */}
      <nav className="w-48 border-r border-agent-divider bg-agent-surface-raised p-3 hidden sm:block">
        <div className="space-y-1">
          {SUB_TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeSub === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => handleSubChange(tab.id)}
                className={cn(
                  'flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-agent-primary-light text-agent-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{tab.label}</span>
                {tab.id === 'review' && pendingCount > 0 && (
                  <span className="bg-agent-error text-white text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center">
                    {pendingCount > 99 ? '99+' : pendingCount}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </nav>

      {/* Mobile sub-tabs */}
      <div className="sm:hidden absolute top-0 left-0 right-0 flex items-center gap-1 px-3 py-2 border-b border-agent-divider overflow-x-auto z-10 bg-agent-surface-raised">
        {SUB_TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = activeSub === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => handleSubChange(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
                isActive
                  ? 'bg-agent-primary text-agent-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
              {tab.id === 'review' && pendingCount > 0 && (
                <span className="bg-agent-error text-white text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0">
        {activeSub === 'preference' && <PreferenceEditor />}
        {activeSub === 'experience' && <ExperienceLibrary />}
        {activeSub === 'review' && <ReviewQueueList />}
      </div>
    </div>
  )
}
