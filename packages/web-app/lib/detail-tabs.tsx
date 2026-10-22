'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react'
import { useAppNavigation, type AppNavigationValue } from '@/lib/app-navigation'
import type { DetailRoute, RouteParams, ViewId } from '@/lib/routes'

export const MAX_DETAIL_TABS = 8

export interface DetailTab {
  key: string
  componentKey: string
  pathname: string
  search: string
  params: RouteParams
  title: string
  fallback: string
  panel: 'scroll' | 'contained'
  ownerView: ViewId
  lastActive: number
}

interface State {
  tabs: DetailTab[]
  activeKey: string | null
  clock: number
}

type Action =
  | { type: 'sync'; tab: Omit<DetailTab, 'lastActive'> | null }
  | { type: 'updatePath'; key: string; pathname: string; search: string }
  | { type: 'close'; key: string }

function fullPath(tab: DetailTab): string {
  return tab.search ? `${tab.pathname}?${tab.search}` : tab.pathname
}

function tabFromNavigation(nav: AppNavigationValue, lastActive: number): DetailTab | null {
  if (nav.mode !== 'detail' || !nav.tabKey || nav.route.kind !== 'detail') return null
  const route: DetailRoute = nav.route
  return {
    key: nav.tabKey,
    componentKey: route.componentKey,
    pathname: nav.pathname,
    search: nav.searchParams.toString(),
    params: nav.params,
    title: route.title(nav.params),
    fallback: route.fallback(nav.params),
    panel: route.panel,
    ownerView: route.ownerView,
    lastActive,
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'sync': {
      if (!action.tab) {
        return state.activeKey === null ? state : { ...state, activeKey: null }
      }
      const clock = state.clock + 1
      const incoming: DetailTab = { ...action.tab, lastActive: clock }
      const existing = state.tabs.findIndex((tab) => tab.key === incoming.key)
      let tabs: DetailTab[]
      if (existing === -1) {
        tabs = [...state.tabs, incoming]
      } else {
        tabs = state.tabs.map((tab) => (tab.key === incoming.key ? incoming : tab))
      }
      if (tabs.length > MAX_DETAIL_TABS) {
        const evictable = tabs
          .filter((tab) => tab.key !== incoming.key)
          .sort((a, b) => a.lastActive - b.lastActive)
        const evicted = evictable[0]
        if (evicted) tabs = tabs.filter((tab) => tab.key !== evicted.key)
      }
      return { tabs, activeKey: incoming.key, clock }
    }
    case 'updatePath': {
      const target = state.tabs.find((tab) => tab.key === action.key)
      if (!target || (target.pathname === action.pathname && target.search === action.search)) {
        return state
      }
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.key === action.key
            ? { ...tab, pathname: action.pathname, search: action.search }
            : tab,
        ),
      }
    }
    case 'close': {
      const tabs = state.tabs.filter((tab) => tab.key !== action.key)
      return {
        tabs,
        activeKey: state.activeKey === action.key ? null : state.activeKey,
        clock: state.clock,
      }
    }
  }
}

function initialState(nav: AppNavigationValue): State {
  const tab = tabFromNavigation(nav, 1)
  if (!tab) return { tabs: [], activeKey: null, clock: 0 }
  return { tabs: [tab], activeKey: tab.key, clock: 1 }
}

export interface DetailTabsContextValue {
  tabs: DetailTab[]
  activeKey: string | null
  focusTab: (tab: DetailTab) => void
  closeTab: (key: string) => void
  updatePath: (key: string, pathname: string, search: string) => void
}

const DetailTabsContext = createContext<DetailTabsContextValue | null>(null)

export function DetailTabsProvider({ children }: { children: ReactNode }) {
  const nav = useAppNavigation()
  if (!nav) throw new Error('DetailTabsProvider must be rendered inside AppNavProvider')
  return <DetailTabsProviderInner nav={nav}>{children}</DetailTabsProviderInner>
}

function DetailTabsProviderInner({
  nav,
  children,
}: {
  nav: AppNavigationValue
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(reducer, nav, initialState)
  const search = nav.searchParams.toString()

  useEffect(() => {
    dispatch({ type: 'sync', tab: tabFromNavigation(nav, 0) })
  }, [nav, search])

  const focusTab = useCallback(
    (tab: DetailTab) => {
      if (nav.tabKey === tab.key) return
      nav.router.replace(fullPath(tab))
    },
    [nav],
  )

  const closeTab = useCallback(
    (key: string) => {
      const tab = state.tabs.find((item) => item.key === key)
      if (!tab) return
      dispatch({ type: 'close', key })
      if (state.activeKey !== key) return
      const next = state.tabs
        .filter((item) => item.key !== key)
        .sort((a, b) => b.lastActive - a.lastActive)[0]
      nav.router.replace(next ? fullPath(next) : tab.fallback)
    },
    [nav, state.activeKey, state.tabs],
  )

  const updatePath = useCallback((key: string, pathname: string, search: string) => {
    dispatch({ type: 'updatePath', key, pathname, search })
  }, [])

  const value = useMemo<DetailTabsContextValue>(
    () => ({
      tabs: state.tabs,
      activeKey: state.activeKey,
      focusTab,
      closeTab,
      updatePath,
    }),
    [closeTab, focusTab, state.activeKey, state.tabs, updatePath],
  )

  return <DetailTabsContext.Provider value={value}>{children}</DetailTabsContext.Provider>
}

export function useDetailTabs(): DetailTabsContextValue {
  const context = useContext(DetailTabsContext)
  if (!context) throw new Error('useDetailTabs must be used inside DetailTabsProvider')
  return context
}
