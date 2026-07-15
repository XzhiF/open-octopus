'use client'

import { useState, useCallback, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { AgentTopBar } from './AgentTopBar'
import { AgentTabs } from './AgentTabs'
import { ChatTab } from '../chat/ChatTab'
import { MemoryTab } from '../memory/MemoryTab'
import { SkillTab } from '../skill/SkillTab'
import { CloneTab } from '../clone/CloneTab'
import { TaskTab } from '../task/TaskTab'
import { ConfigTab } from '../config/ConfigTab'
import { OnboardingCard } from '../shared/OnboardingCard'
import * as api from '@/lib/agent/api'

const TABS = ['chat', 'memory', 'skill', 'clone', 'task', 'config'] as const
type TabId = typeof TABS[number]

function TabContent({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'chat': return <ChatTab />
    case 'memory': return <MemoryTab />
    case 'skill': return <SkillTab />
    case 'clone': return <CloneTab />
    case 'task': return <TaskTab />
    case 'config': return <ConfigTab />
    default: return <ChatTab />
  }
}

function AgentLayoutInner() {
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const tab = searchParams.get('tab')
    return (TABS.includes(tab as TabId) ? tab : 'chat') as TabId
  })
  const [showOnboarding, setShowOnboarding] = useState(false)

  useEffect(() => {
    api.getConfig()
      .then((config) => {
        const cfg = config as { onboarding_completed?: boolean; config?: { onboarding_completed?: boolean } }
        const completed = cfg.onboarding_completed ?? cfg.config?.onboarding_completed ?? true
        if (!completed) setShowOnboarding(true)
      })
      .catch(() => { /* config unavailable — skip onboarding */ })
  }, [])

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab as TabId)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', tab)
    window.history.replaceState({}, '', url.toString())
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentTopBar />
      <AgentTabs activeTab={activeTab} onTabChange={handleTabChange} />
      <div
        className="flex-1 overflow-hidden bg-agent-surface"
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        id={`tabpanel-${activeTab}`}
      >
        <TabContent tab={activeTab} />
      </div>

      {/* M-ONBOARD onboarding wizard */}
      {showOnboarding && (
        <OnboardingCard onComplete={() => setShowOnboarding(false)} />
      )}
    </div>
  )
}

export function AgentLayout() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center flex-1 min-h-0">Loading...</div>}>
      <AgentLayoutInner />
    </Suspense>
  )
}
