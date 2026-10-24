'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { APP_CATALOG, appPreferredSize, appRootPath, isAppId, type AppId } from './app-catalog'
import { matchAppRoute, titleForRoute } from './routes'
import { queryRedirectTarget } from './retired-redirects'
import { useViewport, type Breakpoint } from '@/hooks/use-viewport'
import {
  cascadeRect,
  clampRect,
  maximizeRect,
  stageSize,
  type Rect,
  type Size,
} from './window-geometry'

export type WindowId = AppId | 'dev' | 'not-found'
export type FocusTarget = 'desktop' | WindowId

export interface DesktopWindow {
  id: WindowId
  pathname: string
  search: string
  /** Last app-list route, kept while a detail is open so the view layer stays alive. */
  basePath: string
  baseSearch: string
  rect: Rect
  minimized: boolean
  maximized: boolean
  restoreRect: Rect | null
}

export interface DesktopState {
  windows: Partial<Record<WindowId, DesktopWindow>>
  /** bottom → top */
  order: WindowId[]
  focused: FocusTarget
  viewport: Size
  missionControl: boolean
  hydrated: boolean
}

export type UrlTarget =
  | { kind: 'desktop' }
  | { kind: 'redirect'; to?: string }
  | { kind: 'window'; id: WindowId; pathname: string; search: string }

export const DESKTOP_STORAGE_KEY = 'octopus.desktop.v1'

export interface PersistedWindow {
  id: AppId
  pathname: string
  search: string
  basePath: string
  baseSearch: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  restore: Rect | null
}

export interface PersistedDesktop {
  version: 1
  windows: PersistedWindow[]
  order: AppId[]
  focused: FocusTarget
}

function splitHref(href: string): { pathname: string; search: string } {
  const index = href.indexOf('?')
  if (index === -1) return { pathname: href || '/', search: '' }
  return { pathname: href.slice(0, index) || '/', search: href.slice(index + 1) }
}

export function joinHref(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname
}

export function resolveUrlTarget(href: string): UrlTarget {
  const { pathname, search } = splitHref(href)
  const legacyTarget = queryRedirectTarget(pathname, search)
  if (legacyTarget) return { kind: 'redirect', to: legacyTarget }
  const { route } = matchAppRoute(pathname)
  if (route.kind === 'redirect') return { kind: 'redirect' }
  if (route.kind === 'view') {
    if (route.view === 'chat') return { kind: 'desktop' }
    return { kind: 'window', id: route.view as AppId, pathname, search }
  }
  if (route.kind === 'detail') {
    return { kind: 'window', id: route.ownerView as AppId, pathname, search }
  }
  if (route.kind === 'standalone') {
    return { kind: 'window', id: 'dev', pathname, search }
  }
  return { kind: 'window', id: 'not-found', pathname, search }
}

function baseForNew(id: WindowId, pathname: string, search: string) {
  if (!isAppId(id)) return { basePath: pathname, baseSearch: search }
  const { route } = matchAppRoute(pathname)
  if (route.kind === 'view') return { basePath: pathname, baseSearch: search }
  return { basePath: appRootPath(id), baseSearch: '' }
}

function withRoute(record: DesktopWindow, pathname: string, search: string): DesktopWindow {
  if (record.pathname === pathname && record.search === search) return record
  if (!isAppId(record.id)) {
    return { ...record, pathname, search, basePath: pathname, baseSearch: search }
  }
  const { route } = matchAppRoute(pathname)
  if (route.kind === 'view') {
    return { ...record, pathname, search, basePath: pathname, baseSearch: search }
  }
  return { ...record, pathname, search }
}

function createRecord(id: WindowId, pathname: string, search: string, rect: Rect): DesktopWindow {
  const base = baseForNew(id, pathname, search)
  return {
    id,
    pathname,
    search,
    basePath: base.basePath,
    baseSearch: base.baseSearch,
    rect,
    minimized: false,
    maximized: false,
    restoreRect: null,
  }
}

function topmostVisible(state: DesktopState): WindowId | null {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]
    const record = state.windows[id]
    if (record && !record.minimized) return id
  }
  return null
}

function focusState(state: DesktopState, id: WindowId): DesktopState {
  const record = state.windows[id]
  if (!record) return state
  const order = state.order.filter((item) => item !== id)
  order.push(id)
  const windows = record.minimized
    ? { ...state.windows, [id]: { ...record, minimized: false } }
    : state.windows
  const unchanged =
    state.focused === id &&
    !record.minimized &&
    order.length === state.order.length &&
    order.every((item, index) => item === state.order[index])
  if (unchanged) return state
  return { ...state, windows, order, focused: id }
}

function openState(
  state: DesktopState,
  id: WindowId,
  pathname: string,
  search: string,
): DesktopState {
  const preferred = isAppId(id) ? appPreferredSize(id) : undefined
  const record = createRecord(id, pathname, search, cascadeRect(stageSize(state.viewport), state.order.length, preferred))
  return focusState(
    {
      ...state,
      windows: { ...state.windows, [id]: record },
      order: [...state.order, id],
    },
    id,
  )
}

function applyTarget(state: DesktopState, target: Extract<UrlTarget, { kind: 'window' }>): DesktopState {
  const existing = state.windows[target.id]
  if (!existing) return openState(state, target.id, target.pathname, target.search)
  const next = withRoute(existing, target.pathname, target.search)
  if (next === existing && !existing.minimized && state.focused === target.id) return state
  return focusState(
    { ...state, windows: { ...state.windows, [target.id]: { ...next, minimized: false } } },
    target.id,
  )
}

export type DesktopAction =
  | { type: 'focus'; id: WindowId }
  | { type: 'focusDesktop' }
  | { type: 'open'; id: WindowId; pathname: string; search: string }
  | { type: 'syncUrl'; target: Extract<UrlTarget, { kind: 'window' }> }
  | { type: 'setRoute'; id: WindowId; pathname: string; search: string }
  | { type: 'close'; id: WindowId }
  | { type: 'minimize'; id: WindowId }
  | { type: 'restore'; id: WindowId }
  | { type: 'toggleMaximize'; id: WindowId }
  | { type: 'setRect'; id: WindowId; rect: Rect }
  | { type: 'setViewport'; viewport: Size }
  | { type: 'minimizeAll' }
  | { type: 'closeAll' }
  | { type: 'setMissionControl'; open: boolean }
  | { type: 'toggleMissionControl' }

export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
  switch (action.type) {
    case 'focus':
      return focusState(state, action.id)
    case 'focusDesktop':
      return state.focused === 'desktop' ? state : { ...state, focused: 'desktop' }
    case 'open': {
      if (state.windows[action.id]) return focusState(state, action.id)
      return openState(state, action.id, action.pathname, action.search)
    }
    case 'syncUrl':
      return applyTarget(state, action.target)
    case 'setRoute': {
      const record = state.windows[action.id]
      if (!record) return state
      const next = withRoute(record, action.pathname, action.search)
      if (next === record) return state
      return { ...state, windows: { ...state.windows, [action.id]: next } }
    }
    case 'close': {
      const record = state.windows[action.id]
      if (!record) return state
      const windows = { ...state.windows }
      delete windows[action.id]
      const order = state.order.filter((item) => item !== action.id)
      const focused =
        state.focused === action.id ? (topmostVisible({ ...state, windows, order }) ?? 'desktop') : state.focused
      return { ...state, windows, order, focused }
    }
    case 'minimize': {
      const record = state.windows[action.id]
      if (!record || record.minimized) return state
      const windows = { ...state.windows, [action.id]: { ...record, minimized: true } }
      const focused =
        state.focused === action.id ? (topmostVisible({ ...state, windows }) ?? 'desktop') : state.focused
      return { ...state, windows, focused }
    }
    case 'restore': {
      const record = state.windows[action.id]
      if (!record || !record.minimized) return state
      return focusState({ ...state, windows: { ...state.windows, [action.id]: { ...record, minimized: false } } }, action.id)
    }
    case 'toggleMaximize': {
      const record = state.windows[action.id]
      if (!record) return state
      const stage = stageSize(state.viewport)
      const next = record.maximized
        ? {
            ...record,
            maximized: false,
            minimized: false,
            rect: clampRect(record.restoreRect ?? record.rect, stage),
            restoreRect: null,
          }
        : {
            ...record,
            maximized: true,
            minimized: false,
            restoreRect: record.rect,
          }
      return focusState({ ...state, windows: { ...state.windows, [action.id]: next } }, action.id)
    }
    case 'setRect': {
      const record = state.windows[action.id]
      if (!record || record.maximized) return state
      const rect = clampRect(action.rect, stageSize(state.viewport))
      if (
        rect.x === record.rect.x &&
        rect.y === record.rect.y &&
        rect.w === record.rect.w &&
        rect.h === record.rect.h
      ) {
        return state
      }
      return { ...state, windows: { ...state.windows, [action.id]: { ...record, rect } } }
    }
    case 'setViewport': {
      if (state.viewport.width === action.viewport.width && state.viewport.height === action.viewport.height) {
        return state
      }
      const stage = stageSize(action.viewport)
      const windows: Partial<Record<WindowId, DesktopWindow>> = {}
      for (const [id, record] of Object.entries(state.windows) as Array<[WindowId, DesktopWindow]>) {
        windows[id] = record.maximized ? record : { ...record, rect: clampRect(record.rect, stage) }
      }
      return { ...state, viewport: action.viewport, windows }
    }
    case 'minimizeAll': {
      const windows: Partial<Record<WindowId, DesktopWindow>> = {}
      for (const [id, record] of Object.entries(state.windows) as Array<[WindowId, DesktopWindow]>) {
        windows[id] = { ...record, minimized: true }
      }
      return { ...state, windows, focused: 'desktop' }
    }
    case 'closeAll':
      if (state.order.length === 0 && state.focused === 'desktop') return state
      return { ...state, windows: {}, order: [], focused: 'desktop' }
    case 'setMissionControl':
      return state.missionControl === action.open ? state : { ...state, missionControl: action.open }
    case 'toggleMissionControl':
      return { ...state, missionControl: !state.missionControl }
    default:
      return state
  }
}

export function loadPersistedDesktop(): PersistedDesktop | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(DESKTOP_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedDesktop>
    if (parsed?.version !== 1 || !Array.isArray(parsed.windows) || !Array.isArray(parsed.order)) {
      return null
    }
    const windows = parsed.windows.filter(
      (item): item is PersistedWindow => !!item && typeof item === 'object' && isAppId(String(item.id)),
    )
    const order = parsed.order.filter((id): id is AppId => isAppId(String(id)))
    const focused =
      parsed.focused === 'desktop' || (typeof parsed.focused === 'string' && isAppId(parsed.focused))
        ? (parsed.focused as FocusTarget)
        : 'desktop'
    return { version: 1, windows, order, focused }
  } catch {
    return null
  }
}

export function serializeDesktopState(state: DesktopState): PersistedDesktop {
  const windows: PersistedWindow[] = []
  for (const id of state.order) {
    if (!isAppId(id)) continue
    const record = state.windows[id]
    if (!record) continue
    windows.push({
      id,
      pathname: record.pathname,
      search: record.search,
      basePath: record.basePath,
      baseSearch: record.baseSearch,
      x: record.rect.x,
      y: record.rect.y,
      w: record.rect.w,
      h: record.rect.h,
      minimized: record.minimized,
      maximized: record.maximized,
      restore: record.restoreRect ? { ...record.restoreRect } : null,
    })
  }
  const focused: FocusTarget =
    state.focused === 'desktop' || isAppId(state.focused) ? state.focused : 'desktop'
  return { version: 1, windows, order: state.order.filter(isAppId), focused }
}

export function createInitialState(
  persisted: PersistedDesktop | null,
  href: string,
  viewport: Size,
): DesktopState {
  const stage = stageSize(viewport)
  const windows: Partial<Record<WindowId, DesktopWindow>> = {}
  const order: WindowId[] = []

  if (persisted) {
    for (const item of persisted.windows) {
      const rect = clampRect({ x: item.x, y: item.y, w: item.w, h: item.h }, stage)
      windows[item.id] = {
        id: item.id,
        pathname: item.pathname || appRootPath(item.id),
        search: item.search ?? '',
        basePath: item.basePath || appRootPath(item.id),
        baseSearch: item.baseSearch ?? '',
        rect,
        minimized: !!item.minimized,
        maximized: !!item.maximized,
        restoreRect: item.restore ? clampRect(item.restore, stage) : null,
      }
    }
    for (const id of persisted.order) {
      if (isAppId(id) && windows[id] && !order.includes(id)) order.push(id)
    }
    for (const id of Object.keys(windows) as AppId[]) {
      if (!order.includes(id)) order.push(id)
    }
  }

  let focused: FocusTarget = 'desktop'
  if (persisted && persisted.focused !== 'desktop' && windows[persisted.focused] && !windows[persisted.focused]?.minimized) {
    focused = persisted.focused
  }

  const state: DesktopState = {
    windows,
    order,
    focused,
    viewport,
    missionControl: false,
    hydrated: true,
  }

  const target = resolveUrlTarget(href)
  if (target.kind === 'window') return applyTarget(state, target)
  return { ...state, focused: 'desktop' }
}

export function hrefForFocus(state: DesktopState): string {
  if (state.focused === 'desktop') return '/'
  const record = state.windows[state.focused]
  return record ? joinHref(record.pathname, record.search) : '/'
}

export function windowTitle(record: DesktopWindow): string {
  const { route, params } = matchAppRoute(record.pathname)
  return titleForRoute(route, params)
}

export function windowLabel(id: WindowId): string {
  if (isAppId(id)) return APP_CATALOG[id].label
  return id === 'dev' ? '开发' : '未找到'
}

/** Medium/narrow viewports and maximized windows always fill the stage. */
export function displayRect(
  record: DesktopWindow,
  breakpoint: Breakpoint,
  stage: Size,
): Rect {
  if (breakpoint !== 'wide' || record.maximized) return maximizeRect(stage)
  return record.rect
}

export interface DesktopWindowsContextValue {
  state: DesktopState
  stage: Size
  breakpoint: Breakpoint
  openApp: (id: AppId) => void
  focusWindow: (id: WindowId) => void
  focusDesktop: () => void
  closeWindow: (id: WindowId) => void
  minimizeWindow: (id: WindowId) => void
  restoreWindow: (id: WindowId) => void
  toggleMaximize: (id: WindowId) => void
  minimizeAll: () => void
  closeAll: () => void
  navigateWindow: (from: FocusTarget, href: string, options?: { replace?: boolean }) => void
  setWindowRect: (id: WindowId, rect: Rect) => void
  setMissionControl: (open: boolean) => void
  toggleMissionControl: () => void
}

const DesktopWindowsContext = createContext<DesktopWindowsContextValue | null>(null)

export function DesktopWindowsProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const viewportInfo = useViewport()
  const [state, dispatch] = useReducer(
    desktopReducer,
    null,
    () =>
      createInitialState(loadPersistedDesktop(), `${location.pathname}${location.search}`, {
        width: viewportInfo.width,
        height: viewportInfo.height,
      }),
  )

  const suppressRef = useRef<string | null>(null)
  const lastHrefRef = useRef<string | null>(null)
  const windowsRef = useRef(state.windows)
  windowsRef.current = state.windows

  const pushUrl = useCallback(
    (href: string, replace: boolean) => {
      suppressRef.current = href
      navigate(href, { replace })
    },
    [navigate],
  )

  useEffect(() => {
    dispatch({
      type: 'setViewport',
      viewport: { width: viewportInfo.width, height: viewportInfo.height },
    })
  }, [viewportInfo.width, viewportInfo.height])

  useEffect(() => {
    const href = `${location.pathname}${location.search}`
    if (lastHrefRef.current === href) return
    lastHrefRef.current = href
    if (suppressRef.current === href) {
      suppressRef.current = null
      return
    }
    const target = resolveUrlTarget(href)
    if (target.kind === 'desktop') dispatch({ type: 'focusDesktop' })
    else if (target.kind === 'window') dispatch({ type: 'syncUrl', target })
    else if (target.kind === 'redirect' && target.to) pushUrl(target.to, true)
  }, [location.pathname, location.search, pushUrl])

  const currentHref = `${location.pathname}${location.search}`
  const focusHref = hrefForFocus(state)
  const currentKind = resolveUrlTarget(currentHref).kind

  useEffect(() => {
    if (currentKind === 'redirect') return
    if (focusHref === currentHref) return
    if (suppressRef.current === focusHref) return
    pushUrl(focusHref, true)
  }, [currentHref, currentKind, focusHref, pushUrl])

  useEffect(() => {
    if (!state.hydrated) return
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DESKTOP_STORAGE_KEY, JSON.stringify(serializeDesktopState(state)))
      } catch {
        /* storage unavailable */
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [state])

  const openApp = useCallback(
    (id: AppId) => {
      const record = windowsRef.current[id]
      if (record) {
        dispatch({ type: 'open', id, pathname: record.pathname, search: record.search })
        pushUrl(joinHref(record.pathname, record.search), true)
        return
      }
      const pathname = appRootPath(id)
      dispatch({ type: 'open', id, pathname, search: '' })
      pushUrl(pathname, false)
    },
    [pushUrl],
  )

  const focusWindow = useCallback(
    (id: WindowId) => {
      const record = windowsRef.current[id]
      if (!record) return
      dispatch({ type: 'focus', id })
      pushUrl(joinHref(record.pathname, record.search), true)
    },
    [pushUrl],
  )

  const focusDesktop = useCallback(() => {
    dispatch({ type: 'focusDesktop' })
    pushUrl('/', true)
  }, [pushUrl])

  const closeWindow = useCallback((id: WindowId) => {
    dispatch({ type: 'close', id })
  }, [])

  const minimizeWindow = useCallback((id: WindowId) => {
    dispatch({ type: 'minimize', id })
  }, [])

  const restoreWindow = useCallback((id: WindowId) => {
    dispatch({ type: 'restore', id })
  }, [])

  const toggleMaximize = useCallback((id: WindowId) => {
    dispatch({ type: 'toggleMaximize', id })
  }, [])

  const minimizeAll = useCallback(() => {
    dispatch({ type: 'minimizeAll' })
  }, [])

  const closeAll = useCallback(() => {
    dispatch({ type: 'closeAll' })
  }, [])

  const navigateWindow = useCallback(
    (from: FocusTarget, href: string, options?: { replace?: boolean }) => {
      const target = resolveUrlTarget(href)
      const replace = options?.replace ?? false
      if (target.kind === 'redirect') {
        pushUrl(target.to ?? href, replace)
        return
      }
      if (target.kind === 'desktop') {
        dispatch({ type: 'focusDesktop' })
        pushUrl('/', replace)
        return
      }
      if (from === target.id) {
        dispatch({ type: 'setRoute', id: target.id, pathname: target.pathname, search: target.search })
        dispatch({ type: 'focus', id: target.id })
      } else if (windowsRef.current[target.id]) {
        dispatch({ type: 'syncUrl', target })
      } else {
        dispatch({
          type: 'open',
          id: target.id,
          pathname: target.pathname,
          search: target.search,
        })
      }
      pushUrl(joinHref(target.pathname, target.search), replace)
    },
    [pushUrl],
  )

  const setWindowRect = useCallback((id: WindowId, rect: Rect) => {
    dispatch({ type: 'setRect', id, rect })
  }, [])

  const setMissionControl = useCallback((open: boolean) => {
    dispatch({ type: 'setMissionControl', open })
  }, [])

  const toggleMissionControl = useCallback(() => {
    dispatch({ type: 'toggleMissionControl' })
  }, [])

  const stage = useMemo(() => stageSize(state.viewport), [state.viewport])

  const value = useMemo<DesktopWindowsContextValue>(
    () => ({
      state,
      stage,
      breakpoint: viewportInfo.breakpoint,
      openApp,
      focusWindow,
      focusDesktop,
      closeWindow,
      minimizeWindow,
      restoreWindow,
      toggleMaximize,
      minimizeAll,
      closeAll,
      navigateWindow,
      setWindowRect,
      setMissionControl,
      toggleMissionControl,
    }),
    [
      closeAll,
      closeWindow,
      focusDesktop,
      focusWindow,
      minimizeAll,
      minimizeWindow,
      navigateWindow,
      openApp,
      restoreWindow,
      setMissionControl,
      setWindowRect,
      stage,
      state,
      toggleMaximize,
      toggleMissionControl,
      viewportInfo.breakpoint,
    ],
  )

  return <DesktopWindowsContext.Provider value={value}>{children}</DesktopWindowsContext.Provider>
}

export function useDesktopWindows(): DesktopWindowsContextValue {
  const context = useContext(DesktopWindowsContext)
  if (!context) throw new Error('useDesktopWindows must be used inside DesktopWindowsProvider')
  return context
}
