'use client'

import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { usePathname, useRouter, useSearchParams } from '@/lib/app-navigation'
import {
  BrainCircuit,
  Cpu,
  FolderTree,
  LayoutGrid,
  Lock,
  ShieldQuestion,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentConfig } from '@/hooks/useAgentConfig'
import { listMainAgentVersions } from '@/lib/agent/api'
import { ConfigPane } from '../config/ConfigPane'
import { OverviewPane } from '../overview/OverviewPane'
import { MainAgentFilesPane } from '../files/MainAgentFilesPane'
import { SafetyPane } from './SafetyPane'
import { OnboardingCard } from '../shared/OnboardingCard'

const TABS = ['overview', 'config', 'files', 'safety'] as const
type TabId = (typeof TABS)[number]

const NAV_ITEMS: Array<{
  id: TabId
  index: string
  label: string
  icon: typeof LayoutGrid
}> = [
  { id: 'overview', index: '01', label: '概览', icon: LayoutGrid },
  { id: 'config', index: '02', label: '配置', icon: Cpu },
  { id: 'files', index: '03', label: '文件', icon: FolderTree },
  { id: 'safety', index: '04', label: '安全与调试', icon: ShieldQuestion },
]

const LEGACY_TABS = new Set(['memory', 'skill', 'clone', 'task'])

function AgentLayoutInner() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (requestedTab && TABS.includes(requestedTab as TabId)) return requestedTab as TabId
    return 'overview'
  })
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [version, setVersion] = useState<string | null>(null)

  const {
    config, safeMode, safetyEvents,
    loading, saving, error,
    saveConfig, toggleSafeMode,
  } = useAgentConfig()

  // The global 「对话」 page is the single chat entry now.
  useEffect(() => {
    if (requestedTab === 'chat') router.replace('/')
  }, [requestedTab, router])

  // Old horizontal tabs no longer exist — land on the overview instead.
  useEffect(() => {
    if (requestedTab === 'clone') {
      router.replace('/clones')
      return
    }
    if (requestedTab && LEGACY_TABS.has(requestedTab)) {
      setActiveTab('overview')
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', 'overview')
      router.replace(`${pathname}?${params.toString()}`)
    }
  }, [pathname, requestedTab, router, searchParams])

  // Legacy deep link `/agent?clone=x` now belongs to the 分身 window.
  const legacyCloneRedirected = useRef(false)
  useEffect(() => {
    const legacyClone = searchParams.get('clone')
    if (!legacyClone || legacyCloneRedirected.current) return
    legacyCloneRedirected.current = true
    router.replace(`/clones?clone=${encodeURIComponent(legacyClone)}`)
  }, [router, searchParams])

  useEffect(() => {
    if (!config) return
    const completed = (config as { onboarding_completed?: boolean }).onboarding_completed ?? true
    if (!completed) setShowOnboarding(true)
  }, [config])

  useEffect(() => {
    listMainAgentVersions()
      .then((res) => setVersion(res.versions?.[0]?.version ?? null))
      .catch(() => setVersion(null))
  }, [])

  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tab)
    router.replace(`${pathname}?${params.toString()}`)
  }, [pathname, router, searchParams])

  return (
    <div className="flex h-full min-h-0 flex-col bg-pop-bg">
      {/* Main Agent identity — single compact line. */}
      <header className="flex h-8 flex-none items-center gap-2 border-b border-pop-bd bg-pop-paper px-3">
        <BrainCircuit className="size-[14px] flex-none text-pop-purple" />
        <h1 className="m-0 text-[12px] font-bold leading-none tracking-[-0.01em]">主 Agent</h1>
        <span className="truncate text-[9px] text-pop-dim">
          main · {version ? `v${version}` : '—'} · 独立配置
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className="flex w-[168px] flex-none flex-col border-r border-pop-bd bg-pop-idle px-2 pb-2.5 pt-3"
          aria-label="主 Agent 配置导航"
        >
          <div className="px-2.5 pb-2 pt-0.5 text-[8px] tracking-[0.16em] text-pop-dim">CONFIG</div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeTab === item.id
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`agent-pane-${item.id}`}
                id={`agent-tab-${item.id}`}
                onClick={() => handleTabChange(item.id)}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-[7px] px-[9px] py-2 text-left text-[11.5px] transition-colors',
                  active
                    ? 'bg-pop-paper text-pop-ink'
                    : 'text-pop-dim hover:bg-pop-ink/5 hover:text-pop-ink',
                )}
              >
                {active && (
                  <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded bg-pop-yellow" />
                )}
                <span
                  className={cn(
                    'w-[15px] flex-none text-[8.5px]',
                    active ? 'text-pop-yellow' : 'text-pop-dim/60',
                  )}
                >
                  {item.index}
                </span>
                <Icon className={cn('size-[13px]', active ? 'text-pop-yellow' : 'text-pop-dim/60')} />
                {item.label}
              </button>
            )
          })}

          <div className="mt-auto flex items-start gap-[7px] rounded-[8px] border border-dashed border-pop-purple/20 p-[9px] text-[9px] leading-relaxed text-pop-dim">
            <Lock className="mt-px size-[11px] flex-none text-pop-purple" />
            <span>
              <b className="block text-[9.5px] text-pop-purple">MAIN ONLY</b>
              这里的设置不注入任何分身。
            </span>
          </div>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-[10px] text-pop-dim">
              加载主 Agent 配置…
            </div>
          ) : (
            <>
              <section
                role="tabpanel"
                id="agent-pane-overview"
                aria-labelledby="agent-tab-overview"
                className={cn('flex min-h-0 flex-1 flex-col', activeTab === 'overview' ? 'flex' : 'hidden')}
              >
                <OverviewPane config={config} />
              </section>
              <section
                role="tabpanel"
                id="agent-pane-config"
                aria-labelledby="agent-tab-config"
                className={cn('min-h-0 flex-1 flex-col', activeTab === 'config' ? 'flex' : 'hidden')}
              >
                <ConfigPane
                  config={config}
                  saveConfig={saveConfig}
                  saving={saving}
                  error={error}
                />
              </section>
              <section
                role="tabpanel"
                id="agent-pane-files"
                aria-labelledby="agent-tab-files"
                className={cn('min-h-0 flex-1 flex-col', activeTab === 'files' ? 'flex' : 'hidden')}
              >
                <MainAgentFilesPane />
              </section>
              <section
                role="tabpanel"
                id="agent-pane-safety"
                aria-labelledby="agent-tab-safety"
                className={cn('min-h-0 flex-1 flex-col', activeTab === 'safety' ? 'flex' : 'hidden')}
              >
                <SafetyPane
                  config={config}
                  safeMode={safeMode}
                  safetyEvents={safetyEvents}
                  saving={saving}
                  saveConfig={saveConfig}
                  toggleSafeMode={toggleSafeMode}
                />
              </section>
            </>
          )}
        </main>
      </div>

      {showOnboarding && (
        <OnboardingCard onComplete={() => setShowOnboarding(false)} />
      )}
    </div>
  )
}

export function AgentLayout() {
  return (
    <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-[10px] text-pop-dim">Loading…</div>}>
      <AgentLayoutInner />
    </Suspense>
  )
}
