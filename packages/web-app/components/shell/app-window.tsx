'use client'

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  AppNavigationScope,
  createNavigationScopeValue,
} from '@/lib/app-navigation'
import { isAppId } from '@/lib/app-catalog'
import { matchAppRoute } from '@/lib/routes'
import {
  DETAIL_COMPONENTS,
  STANDALONE_COMPONENTS,
  VIEW_COMPONENTS,
} from '@/lib/route-components'
import {
  displayRect,
  useDesktopWindows,
  windowTitle,
  type DesktopWindow,
  type WindowId,
} from '@/lib/desktop-windows'
import {
  clampRect,
  resizeRect,
  type Rect,
  type ResizeDirection,
} from '@/lib/window-geometry'
import { RouteErrorBoundary } from './route-error-boundary'
import { WindowTitlebar } from './window-titlebar'
import { WindowResizeHandles } from './window-resize-handles'

const NotFoundLazy = lazy(() =>
  import('./not-found-view').then((m) => ({ default: m.NotFoundView })),
)

function WindowLoading() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
      加载窗口…
    </div>
  )
}

function WindowContent({ record, focused }: { record: DesktopWindow; focused: boolean }) {
  const { navigateWindow } = useDesktopWindows()
  const match = matchAppRoute(record.pathname)
  const detailRoute = match.route.kind === 'detail' ? match.route : null
  const isDetail = detailRoute !== null

  const navigateFromWindow = useCallback(
    (target: string) => navigateWindow(record.id, target),
    [navigateWindow, record.id],
  )

  const currentScope = useMemo(
    () =>
      createNavigationScopeValue({
        pathname: record.pathname,
        search: record.search,
        active: focused,
        onNavigate: navigateFromWindow,
      }),
    [focused, navigateFromWindow, record.pathname, record.search],
  )

  const baseScope = useMemo(
    () =>
      createNavigationScopeValue({
        pathname: record.basePath,
        search: record.baseSearch,
        active: focused && !isDetail,
        onNavigate: navigateFromWindow,
      }),
    [focused, isDetail, navigateFromWindow, record.basePath, record.baseSearch],
  )

  const View = isAppId(record.id) ? VIEW_COMPONENTS[record.id] : null
  const Detail = detailRoute ? DETAIL_COMPONENTS[detailRoute.componentKey] : null
  const Standalone =
    match.route.kind === 'standalone'
      ? STANDALONE_COMPONENTS[match.route.componentKey]
      : null

  if (View) {
    return (
      <>
        <div
          className={cn('absolute inset-0 overflow-y-auto', isDetail ? 'hidden' : 'block')}
          aria-hidden={isDetail}
          inert={isDetail}
          data-window-layer="view"
        >
          <RouteErrorBoundary>
            <Suspense fallback={<WindowLoading />}>
              <AppNavigationScope value={baseScope}>
                <View />
              </AppNavigationScope>
            </Suspense>
          </RouteErrorBoundary>
        </div>

        {Detail && detailRoute && (
          <div
            className={cn(
              'absolute inset-0',
              detailRoute.panel === 'contained'
                ? 'flex flex-col overflow-hidden'
                : 'overflow-y-auto',
            )}
            data-window-layer="detail"
          >
            <RouteErrorBoundary>
              <Suspense fallback={<WindowLoading />}>
                <AppNavigationScope value={currentScope}>
                  <Detail />
                </AppNavigationScope>
              </Suspense>
            </RouteErrorBoundary>
          </div>
        )}
      </>
    )
  }

  const Special = Standalone

  if (Special) {
    return (
      <div className="absolute inset-0 overflow-y-auto" data-window-layer="standalone">
        <RouteErrorBoundary>
          <Suspense fallback={<WindowLoading />}>
            <AppNavigationScope value={currentScope}>
              <Special />
            </AppNavigationScope>
          </Suspense>
        </RouteErrorBoundary>
      </div>
    )
  }

  if (match.route.kind === 'not-found') {
    return (
      <div className="absolute inset-0 overflow-y-auto" data-window-layer="not-found">
        <RouteErrorBoundary>
          <Suspense fallback={<WindowLoading />}>
            <AppNavigationScope value={currentScope}>
              <NotFoundLazy />
            </AppNavigationScope>
          </Suspense>
        </RouteErrorBoundary>
      </div>
    )
  }

  return <WindowLoading />
}

interface AppWindowProps {
  id: WindowId
  record: DesktopWindow
  focused: boolean
  hidden: boolean
  missionControl: boolean
  missionTransform?: string
  zIndex: number
}

export function AppWindow({
  id,
  record,
  focused,
  hidden,
  missionControl,
  missionTransform,
  zIndex,
}: AppWindowProps) {
  const {
    stage,
    breakpoint,
    focusWindow,
    closeWindow,
    minimizeWindow,
    toggleMaximize,
    setWindowRect,
  } = useDesktopWindows()

  const rect = displayRect(record, breakpoint, stage)
  const positionerRef = useRef<HTMLDivElement>(null)
  const dragLayerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ rect: Rect; direction: ResizeDirection } | null>(null)
  const resizeLastRef = useRef<Rect | null>(null)
  const canDrag = breakpoint === 'wide' && !record.maximized && !missionControl && !hidden

  const handleFocusPointer = () => {
    if (!focused) focusWindow(id)
  }

  const handleDragStart = () => {
    const layer = dragLayerRef.current
    if (!layer) return
    layer.style.transition = 'none'
    layer.style.willChange = 'transform'
  }

  const handleDragMove = (dx: number, dy: number) => {
    if (dragLayerRef.current) {
      dragLayerRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    }
  }

  const handleDragEnd = (dx: number, dy: number) => {
    const layer = dragLayerRef.current
    if (layer) {
      layer.style.transform = ''
      layer.style.willChange = ''
      layer.style.transition = ''
    }
    const next = clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, stage)
    if (positionerRef.current) {
      positionerRef.current.style.left = `${next.x}px`
      positionerRef.current.style.top = `${next.y}px`
    }
    setWindowRect(id, next)
  }

  const handleResizeStart = (direction: ResizeDirection) => {
    resizeStartRef.current = { rect, direction }
    resizeLastRef.current = rect
  }

  const handleResizeMove = (dx: number, dy: number) => {
    const start = resizeStartRef.current
    if (!start) return
    const next = resizeRect(start.rect, start.direction, dx, dy, stage)
    resizeLastRef.current = next
    const element = positionerRef.current
    if (element) {
      element.style.left = `${next.x}px`
      element.style.top = `${next.y}px`
      element.style.width = `${next.w}px`
      element.style.height = `${next.h}px`
    }
  }

  const handleResizeEnd = () => {
    const next = resizeLastRef.current
    resizeStartRef.current = null
    if (next) setWindowRect(id, next)
  }

  useEffect(() => {
    if (!focused || hidden) return
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(frame)
  }, [focused, hidden, missionControl, record.maximized])

  const title = windowTitle(record)

  return (
    <div
      ref={positionerRef}
      className={cn('absolute', hidden && 'hidden')}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        pointerEvents: missionControl ? 'none' : undefined,
      }}
      data-window-id={id}
      data-window-state={record.minimized ? 'minimized' : focused ? 'focused' : 'idle'}
      role="region"
      aria-label={title}
      onPointerDownCapture={missionControl ? undefined : handleFocusPointer}
    >
      <div
        className="h-full w-full"
        style={{
          transform: missionControl ? missionTransform : undefined,
          transformOrigin: 'top left',
          transition: missionControl ? 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
          opacity: missionControl && record.minimized ? 0.45 : undefined,
        }}
      >
        <div ref={dragLayerRef} className="h-full w-full">
          <div
            className={cn(
              'flex h-full w-full flex-col overflow-hidden rounded-xl border-[1.5px] border-pop-bd bg-pop-paper',
              focused ? 'shadow-pop-lg' : 'shadow-pop',
            )}
            inert={missionControl}
          >
            <WindowTitlebar
              title={title}
              focused={focused}
              canDrag={canDrag}
              onClose={() => closeWindow(id)}
              onMinimize={() => minimizeWindow(id)}
              onToggleMaximize={() => {
                if (breakpoint === 'wide' && !missionControl) toggleMaximize(id)
              }}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragEnd={handleDragEnd}
            />
            <div className="relative min-h-0 flex-1">
              <WindowContent record={record} focused={focused && !missionControl} />
            </div>
          </div>
        </div>
      </div>

      {focused && breakpoint === 'wide' && !record.maximized && !missionControl && !hidden && (
        <WindowResizeHandles
          onStart={handleResizeStart}
          onMove={handleResizeMove}
          onEnd={handleResizeEnd}
        />
      )}
    </div>
  )
}
