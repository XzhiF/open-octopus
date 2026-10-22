'use client'

// 桌面壳自建导航层。
//
// - 顶层视图（/ /dashboard /tasks /workspaces /agent /knowledge /resources
//   /scheduler /system/* /settings）在壳内切换：不触发 Next 导航、不卸载视图，
//   只静默 replaceState 同步 URL（刷新仍能回到当前视图）。
// - 详情路由（/workspaces/:id 等）继续交给 Next 路由渲染，对话常驻不受影响。
// - 无 AppNavProvider 时全部回退 Next 原语义（既有路由页面/测试零变化）。

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import NextLink from 'next/link'
import {
  usePathname as useNextPathname,
  useSearchParams as useNextSearchParams,
  useRouter as useNextRouter,
  type ReadonlyURLSearchParams,
} from 'next/navigation'

type AppRouter = ReturnType<typeof useNextRouter>

const VIEW_IDS: Record<string, string> = {
  '/': 'chat',
  '/dashboard': 'dashboard',
  '/tasks': 'tasks',
  '/workspaces': 'workspaces',
  '/agent': 'agent',
  '/knowledge': 'knowledge',
  '/resources': 'resources',
  '/scheduler': 'scheduler',
  '/settings': 'settings',
}

export function isAppViewPath(pathname: string): boolean {
  if (VIEW_IDS[pathname]) return true
  return pathname === '/system' || pathname.startsWith('/system/')
}

export function viewIdFromPath(pathname: string): string | null {
  if (VIEW_IDS[pathname]) return VIEW_IDS[pathname]
  if (pathname === '/system' || pathname.startsWith('/system/')) return 'system'
  return null
}

function splitFullPath(full: string): { pathname: string; search: string } {
  const q = full.indexOf('?')
  if (q === -1) return { pathname: full, search: '' }
  return { pathname: full.slice(0, q), search: full.slice(q + 1) }
}

function normalizeInternalHref(href: string): string | null {
  if (!href.startsWith('/')) return null
  const { pathname, search } = splitFullPath(href)
  return search ? `${pathname}?${search}` : pathname
}

export interface AppNavigationValue {
  pathname: string
  searchParams: ReadonlyURLSearchParams
  mode: 'view' | 'detail'
  /** 当前顶层视图 id（mode=detail 时为 null）。 */
  view: string | null
  navigate: (href: string, options?: { replace?: boolean }) => void
  router: AppRouter
}

const AppNavigationContext = createContext<AppNavigationValue | null>(null)

export function AppNavProvider({ children }: { children: ReactNode }) {
  const nextPathname = useNextPathname()
  const nextSearchParams = useNextSearchParams()
  const nextRouter = useNextRouter()
  const nextSearch = nextSearchParams.toString()
  const initialFull = nextSearch ? `${nextPathname}?${nextSearch}` : nextPathname

  const [full, setFull] = useState(initialFull)
  const [mode, setMode] = useState<'view' | 'detail'>(isAppViewPath(nextPathname) ? 'view' : 'detail')
  const stackRef = useRef<string[]>([initialFull])
  const lastNextRef = useRef(initialFull)

  const { pathname, search } = useMemo(() => splitFullPath(full), [full])
  const view = mode === 'view' ? viewIdFromPath(pathname) : null

  // Next 真实导航（详情 Link / 浏览器前进后退）→ 同步壳内状态。
  useEffect(() => {
    const nextFull = nextSearch ? `${nextPathname}?${nextSearch}` : nextPathname
    if (nextFull === lastNextRef.current) return
    lastNextRef.current = nextFull
    setFull(nextFull)
    setMode(isAppViewPath(nextPathname) ? 'view' : 'detail')
  }, [nextPathname, nextSearch])

  useEffect(() => {
    const onPop = () => {
      const current = window.location.pathname + window.location.search
      setFull(current)
      setMode(isAppViewPath(window.location.pathname) ? 'view' : 'detail')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((href: string, options?: { replace?: boolean }) => {
    const target = normalizeInternalHref(href)
    if (!target) return
    const { pathname: targetPath } = splitFullPath(target)

    if (isAppViewPath(targetPath)) {
      setFull(target)
      setMode('view')
      if (options?.replace) {
        stackRef.current[stackRef.current.length - 1] = target
      } else {
        stackRef.current = [...stackRef.current, target]
      }
      try {
        window.history.replaceState(null, '', target)
      } catch {
        /* history unavailable */
      }
      return
    }

    setFull(target)
    setMode('detail')
    if (options?.replace) nextRouter.replace(href)
    else nextRouter.push(href)
  }, [nextRouter])

  const router = useMemo(() => ({
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, { replace: true }),
    back: () => {
      if (stackRef.current.length > 1) {
        stackRef.current = stackRef.current.slice(0, -1)
        const previous = stackRef.current[stackRef.current.length - 1]
        setFull(previous)
        setMode(isAppViewPath(splitFullPath(previous).pathname) ? 'view' : 'detail')
        try {
          window.history.replaceState(null, '', previous)
        } catch {
          /* history unavailable */
        }
      } else {
        nextRouter.back()
      }
    },
    forward: () => nextRouter.forward(),
    refresh: () => nextRouter.refresh(),
    prefetch: (href: string) => {
      const target = normalizeInternalHref(href)
      if (target && !isAppViewPath(splitFullPath(target).pathname)) nextRouter.prefetch(href)
    },
  }) as unknown as AppRouter, [navigate, nextRouter])

  const searchParams = useMemo(
    () => new URLSearchParams(search) as unknown as ReadonlyURLSearchParams,
    [search],
  )

  const value = useMemo<AppNavigationValue>(() => ({
    pathname, searchParams, mode, view, navigate, router,
  }), [pathname, searchParams, mode, view, navigate, router])

  return <AppNavigationContext.Provider value={value}>{children}</AppNavigationContext.Provider>
}

/** 壳内状态（AppShell/ViewHost 专用）。无 Provider 时返回 null。 */
export function useAppNavigation(): AppNavigationValue | null {
  return useContext(AppNavigationContext)
}

/** ViewHost 给每个常驻视图套独立作用域：隐藏视图保留自己的 path/search，
 *  不会被当前活动视图的导航状态串味。 */
export function AppNavigationScope({
  value,
  children,
}: {
  value: AppNavigationValue | null
  children: ReactNode
}) {
  return <AppNavigationContext.Provider value={value}>{children}</AppNavigationContext.Provider>
}

// ── Next 同名 hook：Provider 内走壳内状态，Provider 外回退 Next 原语义 ──

export function usePathname(): string {
  const context = useContext(AppNavigationContext)
  const nextPathname = useNextPathname()
  return context?.pathname ?? nextPathname
}

export function useSearchParams(): ReadonlyURLSearchParams {
  const context = useContext(AppNavigationContext)
  const nextSearchParams = useNextSearchParams()
  return context?.searchParams ?? nextSearchParams
}

export function useRouter(): AppRouter {
  const context = useContext(AppNavigationContext)
  const nextRouter = useNextRouter()
  return context?.router ?? nextRouter
}

type AppLinkProps = ComponentProps<typeof NextLink>

export default function AppLink(props: AppLinkProps) {
  const context = useContext(AppNavigationContext)
  const { href, children, onClick, ...rest } = props

  if (!context) {
    return <NextLink {...props} />
  }

  const hrefString = typeof href === 'string' ? href : String(href)
  const external = !hrefString.startsWith('/')
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || external) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = (rest as { target?: string }).target
    if (target && target !== '_self') return
    event.preventDefault()
    context.navigate(hrefString)
  }

  const {
    prefetch: _prefetch, replace: _replace, scroll: _scroll, shallow: _shallow,
    locale: _locale, legacyBehavior: _legacyBehavior, passHref: _passHref,
    onNavigate: _onNavigate, ...anchorProps
  } = rest as Record<string, unknown>
  void _prefetch; void _replace; void _scroll; void _shallow
  void _locale; void _legacyBehavior; void _passHref; void _onNavigate

  return (
    <a
      href={hrefString}
      onClick={handleClick}
      {...(anchorProps as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
    >
      {children}
    </a>
  )
}