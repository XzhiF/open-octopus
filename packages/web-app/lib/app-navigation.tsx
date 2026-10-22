'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react'
import {
  MemoryRouter,
  useInRouterContext,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import {
  matchAppRoute,
  titleForRoute,
  type AppRoute,
  type RouteParams,
  type ViewId,
} from './routes'

export interface AppRouter {
  push: (href: string, options?: { replace?: boolean; scroll?: boolean }) => void
  replace: (href: string, options?: { scroll?: boolean }) => void
  back: () => void
  forward: () => void
  refresh: () => void
  prefetch: (href: string) => void
}

export interface AppNavigationValue {
  pathname: string
  searchParams: URLSearchParams
  params: RouteParams
  mode: 'view' | 'detail' | 'standalone' | 'not-found' | 'redirect'
  view: ViewId | null
  route: AppRoute
  active: boolean
  tabKey: string | null
  navigate: (href: string, options?: { replace?: boolean }) => void
  router: AppRouter
}

const AppNavigationContext = createContext<AppNavigationValue | null>(null)

function currentWindowPathname(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname
}

function currentWindowSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}

function searchOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
}

function normalizeInternalHref(href: string, basePathname: string): string | null {
  if (!href) return null
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
    if (typeof window === 'undefined') return null
    try {
      const url = new URL(href, window.location.origin)
      if (url.origin !== window.location.origin) return null
      return `${url.pathname}${url.search}${url.hash}`
    } catch {
      return null
    }
  }
  if (href.startsWith('?')) return `${basePathname}${href}`
  if (href.startsWith('#')) return null
  if (href.startsWith('/')) return href
  return null
}

function createRouter(navigate: AppNavigationValue['navigate'], nativeNavigate?: (delta: number) => void): AppRouter {
  return {
    push: (href, options) => navigate(href, { replace: options?.replace }),
    replace: (href) => navigate(href, { replace: true }),
    back: () => {
      if (nativeNavigate) nativeNavigate(-1)
      else if (typeof window !== 'undefined') window.history.back()
    },
    forward: () => {
      if (nativeNavigate) nativeNavigate(1)
      else if (typeof window !== 'undefined') window.history.forward()
    },
    refresh: () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('octopus:refresh'))
      }
    },
    prefetch: () => {},
  }
}

function fallbackRouter(): AppRouter {
  const navigate: AppNavigationValue['navigate'] = (href, options) => {
    if (typeof window === 'undefined') return
    const target = normalizeInternalHref(href, window.location.pathname)
    if (!target) return
    window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', target)
  }
  return createRouter(navigate)
}

const FALLBACK_VALUE: AppNavigationValue = {
  pathname: currentWindowPathname(),
  searchParams: searchOf(currentWindowSearch()),
  params: matchAppRoute(currentWindowPathname()).params,
  mode: 'view',
  view: null,
  route: matchAppRoute(currentWindowPathname()).route,
  active: true,
  tabKey: null,
  navigate: (href, options) => {
    if (typeof window === 'undefined') return
    const target = normalizeInternalHref(href, window.location.pathname)
    if (!target) return
    window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', target)
  },
  router: fallbackRouter(),
}

export interface ScopedNavigationOptions {
  pathname: string
  search?: string
  active?: boolean
  onNavigate: (target: string, options?: { replace?: boolean }) => void
}

/** 隐藏视图/标签的导航作用域：只更新自己的 pinned 路径，不碰全局 URL。 */
export function createNavigationScopeValue({
  pathname,
  search = '',
  active = false,
  onNavigate,
}: ScopedNavigationOptions): AppNavigationValue {
  const { route, params } = matchAppRoute(pathname)
  const navigate: AppNavigationValue['navigate'] = (href, options) => {
    const target = normalizeInternalHref(href, pathname)
    if (!target) return
    onNavigate(target, options)
  }
  return {
    pathname,
    searchParams: searchOf(search),
    params,
    mode: route.kind === 'redirect' ? 'redirect' : route.kind,
    view: route.kind === 'view' ? route.view : null,
    route,
    active,
    tabKey: route.kind === 'detail' ? route.key(params) : null,
    navigate,
    router: createRouter(navigate),
  }
}

function AppNavProviderInner({ children }: { children: ReactNode }) {
  const location = useLocation()
  const nativeNavigate = useNavigate()
  const match = useMemo(() => matchAppRoute(location.pathname), [location.pathname])
  const { route, params } = match

  const navigate = useCallback<AppNavigationValue['navigate']>(
    (href, options) => {
      const target = normalizeInternalHref(href, location.pathname)
      if (!target) return
      nativeNavigate(target, { replace: options?.replace })
    },
    [location.pathname, nativeNavigate],
  )

  useEffect(() => {
    if (route.kind !== 'redirect') return
    const target = typeof route.to === 'function' ? route.to(params) : route.to
    nativeNavigate(target, { replace: true })
  }, [nativeNavigate, params, route])

  useEffect(() => {
    const title = titleForRoute(route, params)
    document.title = title === '对话' ? 'Octopus' : `${title} - Octopus`
  }, [params, route])

  const router = useMemo(
    () => createRouter(navigate, nativeNavigate),
    [navigate, nativeNavigate],
  )

  const value = useMemo<AppNavigationValue>(() => ({
    pathname: location.pathname,
    searchParams: searchOf(location.search),
    params,
    mode: route.kind === 'redirect' ? 'redirect' : route.kind,
    view: route.kind === 'view' ? route.view : null,
    route,
    active: true,
    tabKey: route.kind === 'detail' ? route.key(params) : null,
    navigate,
    router,
  }), [location.pathname, location.search, navigate, params, route, router])

  return <AppNavigationContext.Provider value={value}>{children}</AppNavigationContext.Provider>
}

export function AppNavProvider({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext()
  if (!inRouter) {
    const initial = `${currentWindowPathname()}${currentWindowSearch()}`
    return (
      <MemoryRouter initialEntries={[initial]}>
        <AppNavProviderInner>{children}</AppNavProviderInner>
      </MemoryRouter>
    )
  }
  return <AppNavProviderInner>{children}</AppNavProviderInner>
}

/** 壳内状态（AppShell/ViewHost/DetailTabsHost 专用）。无 Provider 时返回 null。 */
export function useAppNavigation(): AppNavigationValue | null {
  return useContext(AppNavigationContext)
}

export function AppNavigationScope({
  value,
  children,
}: {
  value: AppNavigationValue | null
  children: ReactNode
}) {
  return <AppNavigationContext.Provider value={value}>{children}</AppNavigationContext.Provider>
}

export function usePathname(): string {
  const context = useContext(AppNavigationContext)
  return context?.pathname ?? currentWindowPathname()
}

export function useSearchParams(): URLSearchParams {
  const context = useContext(AppNavigationContext)
  return context?.searchParams ?? searchOf(currentWindowSearch())
}

export function useParams(): RouteParams {
  const context = useContext(AppNavigationContext)
  return context?.params ?? matchAppRoute(currentWindowPathname()).params
}

export function useRouter(): AppRouter {
  const context = useContext(AppNavigationContext)
  return context?.router ?? FALLBACK_VALUE.router
}

/** 隐藏视图/标签里的全局快捷键必须先用它门禁。 */
export function useIsActiveRoute(): boolean {
  const context = useContext(AppNavigationContext)
  return context?.active ?? true
}

type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean
}

export default function AppLink({
  href,
  children,
  onClick,
  replace,
  scroll: _scroll,
  prefetch: _prefetch,
  ...rest
}: AppLinkProps) {
  void _scroll
  void _prefetch
  const context = useContext(AppNavigationContext)
  const external = !href.startsWith('/') && !href.startsWith('?')

  if (!context) {
    return (
      <a href={href} onClick={onClick} {...rest}>
        {children}
      </a>
    )
  }

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || external) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = rest.target
    if (target && target !== '_self') return
    if (rest.download !== undefined) return
    event.preventDefault()
    context.navigate(href, { replace })
  }

  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
}
