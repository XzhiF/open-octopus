'use client'

// 桌面壳 ViewHost：顶层视图按需懒挂载一次，之后常驻（只隐藏不卸载），
// 切视图不丢滚动/筛选/弹窗状态。每个视图有独立导航作用域，避免互串 search params。
// 对话视图由 AppShell 单独常驻（chat 不在此表）。

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import { cn } from '@/lib/utils'
import {
  AppNavigationScope,
  useAppNavigation,
  type AppNavigationValue,
} from '@/lib/app-navigation'
import type { ReadonlyURLSearchParams } from 'next/navigation'

function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
      加载视图…
    </div>
  )
}

const VIEWS: Record<string, ComponentType> = {
  dashboard: dynamic(() => import('@/app/dashboard/page'), { ssr: false, loading: ViewLoading }),
  tasks: dynamic(() => import('@/app/tasks/page'), { ssr: false, loading: ViewLoading }),
  workspaces: dynamic(() => import('@/app/workspaces/page'), { ssr: false, loading: ViewLoading }),
  agent: dynamic(
    () => import('@/components/agent/layout/AgentLayout').then((m) => m.AgentLayout),
    { ssr: false, loading: ViewLoading },
  ),
  knowledge: dynamic(() => import('@/app/knowledge/page'), { ssr: false, loading: ViewLoading }),
  resources: dynamic(
    () => import('./resources-view').then((m) => m.ResourcesView),
    { ssr: false, loading: ViewLoading },
  ),
  scheduler: dynamic(() => import('@/app/scheduler/page'), { ssr: false, loading: ViewLoading }),
  system: dynamic(
    () => import('./system-view').then((m) => m.SystemView),
    { ssr: false, loading: ViewLoading },
  ),
  settings: dynamic(
    () => import('./settings-view').then((m) => m.SettingsView),
    { ssr: false, loading: ViewLoading },
  ),
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
  globalValue: AppNavigationValue | null
  onPin: (id: string, entry: PinnedNav) => void
  View: ComponentType
}) {
  const value = useMemo<AppNavigationValue | null>(() => {
    if (active && globalValue) return globalValue

    const entry = pinned ?? { pathname: BASE_PATH[id] ?? '/', search: '' }
    const searchParams = new URLSearchParams(entry.search) as unknown as ReadonlyURLSearchParams
    const navigate = (href: string) => onPin(id, splitFull(href))
    const router = {
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href),
      back: () => {},
      forward: () => {},
      refresh: () => {},
      prefetch: () => {},
    } as unknown as AppNavigationValue['router']
    return { pathname: entry.pathname, searchParams, mode: 'view', view: id, navigate, router }
  }, [active, globalValue, pinned, id, onPin])

  return (
    <AppNavigationScope value={value}>
      <View />
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
    if (!activeView || !VIEWS[activeView]) return
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
    <div className={cn('min-h-0 flex-1', activeView ? 'block' : 'hidden')} aria-hidden={!activeView}>
      {mounted.map((id) => (
        <div
          key={id}
          className={cn('h-full min-h-0 overflow-y-auto', id === activeView ? 'block' : 'hidden')}
          aria-hidden={id !== activeView}
        >
          <ViewScope
            id={id}
            active={id === activeView}
            pinned={pinned[id]}
            globalValue={globalValue}
            onPin={onPin}
            View={VIEWS[id]}
          />
        </div>
      ))}
    </div>
  )
}