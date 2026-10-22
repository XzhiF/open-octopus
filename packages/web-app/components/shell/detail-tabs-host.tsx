'use client'

import { useEffect } from 'react'
import { useDetailTabs, type DetailTab } from '@/lib/detail-tabs'
import { AppNavigationScope, createNavigationScopeValue, useAppNavigation } from '@/lib/app-navigation'
import { DETAIL_COMPONENTS } from '@/lib/route-components'
import { cn } from '@/lib/utils'
import { RouteErrorBoundary } from './route-error-boundary'
import { Suspense, useMemo } from 'react'

function PanelLoading() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center font-mono text-[11px] text-pop-dim">
      加载详情…
    </div>
  )
}

function PanelEffects({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(frame)
  }, [active])
  return null
}

function splitTarget(target: string): { pathname: string; search: string } {
  const index = target.indexOf('?')
  if (index === -1) return { pathname: target, search: '' }
  return { pathname: target.slice(0, index), search: target.slice(index + 1) }
}

function DetailPanel({
  tab,
  active,
  updatePath,
}: {
  tab: DetailTab
  active: boolean
  updatePath: (key: string, pathname: string, search: string) => void
}) {
  const globalValue = useAppNavigation()
  const value = useMemo(() => {
    if (active && globalValue) return globalValue
    return createNavigationScopeValue({
      pathname: tab.pathname,
      search: tab.search,
      onNavigate: (target) => {
        const next = splitTarget(target)
        updatePath(tab.key, next.pathname, next.search)
      },
    })
  }, [active, globalValue, tab.key, tab.pathname, tab.search, updatePath])

  const Component = DETAIL_COMPONENTS[tab.componentKey]

  return (
    <div
      className={cn('absolute inset-0 min-h-0', active ? 'flex flex-col' : 'hidden')}
      aria-hidden={!active}
      inert={!active}
      data-detail-tab={tab.key}
    >
      <PanelEffects active={active} />
      <RouteErrorBoundary>
        <Suspense fallback={<PanelLoading />}>
          <AppNavigationScope value={value}>
            <div
              className={cn(
                'min-h-0 flex-1',
                tab.panel === 'contained' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
              )}
            >
              {Component ? <Component /> : <PanelLoading />}
            </div>
          </AppNavigationScope>
        </Suspense>
      </RouteErrorBoundary>
    </div>
  )
}

export function DetailTabsHost() {
  const { tabs, activeKey, updatePath } = useDetailTabs()
  return (
    <div
      className={cn('absolute inset-0', activeKey ? '' : 'pointer-events-none')}
      data-testid="detail-tabs-host"
    >
      {tabs.map((tab) => (
        <DetailPanel
          key={tab.key}
          tab={tab}
          active={tab.key === activeKey}
          updatePath={updatePath}
        />
      ))}
    </div>
  )
}
