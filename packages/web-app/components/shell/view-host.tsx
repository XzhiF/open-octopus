'use client'

// 桌面壳 ViewHost：顶层视图按需懒挂载一次，之后常驻（只隐藏不卸载），
// 切视图不丢滚动/筛选/弹窗状态。每个视图有独立导航作用域，避免互串 search params。
// 对话视图由 AppShell 单独常驻（chat 不在此表）。

import { Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import { cn } from '@/lib/utils'
import {
  AppNavigationScope,
  createNavigationScopeValue,
  useAppNavigation,
} from '@/lib/app-navigation'
import { VIEW_COMPONENTS } from '@/lib/route-components'
import { RouteErrorBoundary } from './route-error-boundary'

function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
      加载视图…
    </div>
  )
}

const BASE_PATH: Record<string, string> = {
  dashboard: '/dashboard',
  tasks: '/tasks',
  workspaces: '/workspaces',
  agent: '/agent',
  knowledge: '/knowledge',
  resources: '/resources',
  scheduler: '/scheduler',
  system: '/system/models',
  settings: '/settings',
}

interface PinnedNav {
  pathname: string
  search: string
}

function splitFull(full: string): PinnedNav {
  const q = full.indexOf('?')
  if (q === -1) return { pathname: full, search: '' }
  return { pathname: full.slice(0, q), search: full.slice(q + 1) }
}

function ViewScope({
  id,
  active,
  pinned,
  globalValue,
  onPin,
  View,
}: {
  id: string
  active: boolean
  pinned: PinnedNav | undefined
  globalValue: ReturnType<typeof useAppNavigation>
  onPin: (id: string, entry: PinnedNav) => void
  View: ComponentType
}) {
  const value = useMemo(() => {
    if (active && globalValue) return globalValue
    const entry = pinned ?? { pathname: BASE_PATH[id] ?? '/', search: '' }
    return createNavigationScopeValue({
      pathname: entry.pathname,
      search: entry.search,
      onNavigate: (target) => onPin(id, splitFull(target)),
    })
  }, [active, globalValue, pinned, id, onPin])

  return (
    <AppNavigationScope value={value}>
      <Suspense fallback={<ViewLoading />}>
        <View />
      </Suspense>
    </AppNavigationScope>
  )
}

export function ViewHost({ activeView }: { activeView: string | null }) {
  const globalValue = useAppNavigation()
  const [mounted, setMounted] = useState<string[]>([])
  const [pinned, setPinned] = useState<Record<string, PinnedNav>>({})

  const onPin = useCallback((id: string, entry: PinnedNav) => {
    setPinned((prev) => ({ ...prev, [id]: entry }))
  }, [])

  useEffect(() => {
    if (!activeView || !VIEW_COMPONENTS[activeView as keyof typeof VIEW_COMPONENTS]) return
    setMounted((prev) => (prev.includes(activeView) ? prev : [...prev, activeView]))
    if (globalValue) {
      setPinned((prev) => ({
        ...prev,
        [activeView]: {
          pathname: globalValue.pathname,
          search: globalValue.searchParams.toString(),
        },
      }))
    }
  }, [activeView, globalValue])

  return (
    <div
      className={cn('relative min-h-0 flex-1', activeView ? 'flex flex-col' : 'hidden')}
      aria-hidden={!activeView}
    >
      {mounted.map((id) => {
        const View = VIEW_COMPONENTS[id as keyof typeof VIEW_COMPONENTS]
        if (!View) return null
        const active = id === activeView
        return (
          <div
            key={id}
            className={cn('h-full min-h-0 overflow-y-auto', active ? 'block' : 'hidden')}
            aria-hidden={!active}
            inert={!active}
            data-view-id={id}
          >
            <RouteErrorBoundary>
              <ViewScope
                id={id}
                active={active}
                pinned={pinned[id]}
                globalValue={globalValue}
                onPin={onPin}
                View={View}
              />
            </RouteErrorBoundary>
          </div>
        )
      })}
    </div>
  )
}
