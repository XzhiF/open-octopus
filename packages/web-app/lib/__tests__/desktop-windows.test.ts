import { describe, expect, it } from 'vitest'
import {
  createInitialState,
  desktopReducer,
  hrefForFocus,
  joinHref,
  resolveUrlTarget,
  serializeDesktopState,
  type DesktopState,
  type PersistedDesktop,
} from '@/lib/desktop-windows'
import { HEADER_HEIGHT } from '@/lib/window-geometry'

const VIEWPORT = { width: 1440, height: 900 }

function open(state: DesktopState, id: 'tasks' | 'workspaces' | 'dashboard', href: string) {
  const [pathname, search = ''] = href.split('?')
  return desktopReducer(state, { type: 'open', id, pathname, search })
}

describe('resolveUrlTarget', () => {
  it('maps every route family to an owning window', () => {
    expect(resolveUrlTarget('/')).toEqual({ kind: 'desktop' })
    expect(resolveUrlTarget('/?x=1')).toEqual({ kind: 'desktop' })
    expect(resolveUrlTarget('/tasks')).toEqual({
      kind: 'window',
      id: 'tasks',
      pathname: '/tasks',
      search: '',
    })
    expect(resolveUrlTarget('/workspaces/ws-1')).toEqual({
      kind: 'window',
      id: 'workspaces',
      pathname: '/workspaces/ws-1',
      search: '',
    })
    expect(resolveUrlTarget('/workspaces/ws-1/executions/e1/observability')).toMatchObject({
      id: 'workspaces',
    })
    expect(resolveUrlTarget('/resources/skill/demo')).toMatchObject({ id: 'resources' })
    expect(resolveUrlTarget('/scheduler/jobs/j1')).toMatchObject({ id: 'scheduler' })
    expect(resolveUrlTarget('/system/models')).toMatchObject({ id: 'system' })
    expect(resolveUrlTarget('/dev/harness-test')).toMatchObject({ id: 'dev' })
    expect(resolveUrlTarget('/nope')).toMatchObject({ id: 'not-found' })
    expect(resolveUrlTarget('/system')).toEqual({ kind: 'redirect' })
    expect(resolveUrlTarget('/wiki/anything')).toEqual({ kind: 'redirect' })
    expect(resolveUrlTarget('/agent?tab=chat')).toEqual({ kind: 'redirect', to: '/' })
    expect(resolveUrlTarget('/agent?tab=memory')).toMatchObject({
      kind: 'window',
      id: 'agent',
      pathname: '/agent',
      search: 'tab=memory',
    })
  })
})

describe('createInitialState', () => {
  it('opens and focuses the window owning a deep link', () => {
    const state = createInitialState(null, '/workspaces/ws-1?tab=files', VIEWPORT)
    const record = state.windows.workspaces
    expect(record).toBeDefined()
    expect(record?.pathname).toBe('/workspaces/ws-1')
    expect(record?.search).toBe('tab=files')
    expect(record?.basePath).toBe('/workspaces')
    expect(state.focused).toBe('workspaces')
    expect(state.order).toEqual(['workspaces'])
  })

  it('restores the layout but lets a / URL focus the desktop', () => {
    const persisted: PersistedDesktop = {
      version: 1,
      windows: [
        {
          id: 'tasks',
          pathname: '/tasks',
          search: '',
          basePath: '/tasks',
          baseSearch: '',
          x: 100,
          y: 80,
          w: 900,
          h: 600,
          minimized: false,
          maximized: false,
          restore: null,
        },
      ],
      order: ['tasks'],
      focused: 'tasks',
    }
    const state = createInitialState(persisted, '/', VIEWPORT)
    expect(state.windows.tasks?.rect).toEqual({ x: 100, y: 80, w: 900, h: 600 })
    expect(state.focused).toBe('desktop')
    expect(state.order).toEqual(['tasks'])
  })

  it('lets a deep link win over persisted focus and restores minimized windows', () => {
    const persisted: PersistedDesktop = {
      version: 1,
      windows: [
        {
          id: 'dashboard',
          pathname: '/dashboard',
          search: '',
          basePath: '/dashboard',
          baseSearch: '',
          x: 0,
          y: 0,
          w: 800,
          h: 500,
          minimized: true,
          maximized: false,
          restore: null,
        },
      ],
      order: ['dashboard'],
      focused: 'desktop',
    }
    const state = createInitialState(persisted, '/dashboard', VIEWPORT)
    expect(state.focused).toBe('dashboard')
    expect(state.windows.dashboard?.minimized).toBe(false)
  })
})

describe('desktopReducer', () => {
  it('opens each app once and raises focused windows', () => {
    let state = createInitialState(null, '/', VIEWPORT)
    state = open(state, 'tasks', '/tasks')
    state = open(state, 'workspaces', '/workspaces')
    state = open(state, 'tasks', '/tasks')
    expect(Object.keys(state.windows)).toHaveLength(2)
    expect(state.order).toEqual(['workspaces', 'tasks'])
    expect(state.focused).toBe('tasks')
  })

  it('focuses the next visible window when the focused one is minimized', () => {
    let state = createInitialState(null, '/', VIEWPORT)
    state = open(state, 'dashboard', '/dashboard')
    state = open(state, 'tasks', '/tasks')
    state = desktopReducer(state, { type: 'minimize', id: 'tasks' })
    expect(state.focused).toBe('dashboard')
    expect(state.windows.tasks?.minimized).toBe(true)
  })

  it('closes without changing focus when a background window closes', () => {
    let state = createInitialState(null, '/', VIEWPORT)
    state = open(state, 'dashboard', '/dashboard')
    state = open(state, 'tasks', '/tasks')
    state = desktopReducer(state, { type: 'close', id: 'dashboard' })
    expect(state.focused).toBe('tasks')
    expect(state.order).toEqual(['tasks'])
  })

  it('returns to the desktop when the last window closes', () => {
    let state = createInitialState(null, '/tasks', VIEWPORT)
    state = desktopReducer(state, { type: 'close', id: 'tasks' })
    expect(state.focused).toBe('desktop')
    expect(state.order).toEqual([])
  })

  it('stores and restores the pre-maximize rect', () => {
    let state = createInitialState(null, '/tasks', VIEWPORT)
    const before = state.windows.tasks?.rect
    state = desktopReducer(state, { type: 'toggleMaximize', id: 'tasks' })
    expect(state.windows.tasks?.maximized).toBe(true)
    expect(state.windows.tasks?.restoreRect).toEqual(before)
    state = desktopReducer(state, { type: 'toggleMaximize', id: 'tasks' })
    expect(state.windows.tasks?.maximized).toBe(false)
    expect(state.windows.tasks?.rect).toEqual(before)
  })

  it('keeps the base view path while a detail is open', () => {
    let state = createInitialState(null, '/workspaces?tab=list', VIEWPORT)
    state = desktopReducer(state, {
      type: 'setRoute',
      id: 'workspaces',
      pathname: '/workspaces/ws-1',
      search: '',
    })
    expect(state.windows.workspaces?.pathname).toBe('/workspaces/ws-1')
    expect(state.windows.workspaces?.basePath).toBe('/workspaces')
    expect(state.windows.workspaces?.baseSearch).toBe('tab=list')
  })

  it('minimizes all windows for show-desktop', () => {
    let state = createInitialState(null, '/', VIEWPORT)
    state = open(state, 'tasks', '/tasks')
    state = open(state, 'dashboard', '/dashboard')
    state = desktopReducer(state, { type: 'minimizeAll' })
    expect(state.focused).toBe('desktop')
    expect(state.windows.tasks?.minimized).toBe(true)
    expect(state.windows.dashboard?.minimized).toBe(true)
  })

  it('re-clamps floating windows when the viewport shrinks', () => {
    let state = createInitialState(null, '/tasks', VIEWPORT)
    const original = state.windows.tasks?.rect
    state = desktopReducer(state, {
      type: 'setViewport',
      viewport: { width: 800, height: 700 - HEADER_HEIGHT },
    })
    const rect = state.windows.tasks?.rect
    expect(rect?.w).toBeLessThanOrEqual(800)
    expect(rect?.h).toBeLessThanOrEqual(700 - HEADER_HEIGHT)
    expect(rect).not.toEqual(original)
  })
})

describe('persistence', () => {
  it('round-trips app windows but never dev/404 windows', () => {
    let state = createInitialState(null, '/tasks', VIEWPORT)
    state = open(state, 'workspaces', '/workspaces')
    state = desktopReducer(state, {
      type: 'syncUrl',
      target: { kind: 'window', id: 'dev', pathname: '/dev/harness-test', search: '' },
    })
    const persisted = serializeDesktopState(state)
    expect(persisted.version).toBe(1)
    expect(persisted.windows.map((item) => item.id)).toEqual(['tasks', 'workspaces'])
    expect(persisted.focused).toBe('desktop')
    const restored = createInitialState(persisted, '/tasks', VIEWPORT)
    expect(restored.windows.tasks?.pathname).toBe('/tasks')
    expect(restored.windows.workspaces?.pathname).toBe('/workspaces')
    expect(restored.focused).toBe('tasks')
  })

  it('builds the focused URL and joins queries', () => {
    let state = createInitialState(null, '/resources?tab=list', VIEWPORT)
    expect(hrefForFocus(state)).toBe('/resources?tab=list')
    state = desktopReducer(state, { type: 'focusDesktop' })
    expect(hrefForFocus(state)).toBe('/')
    expect(joinHref('/tasks', '')).toBe('/tasks')
    expect(joinHref('/tasks', 'a=1')).toBe('/tasks?a=1')
  })
})
