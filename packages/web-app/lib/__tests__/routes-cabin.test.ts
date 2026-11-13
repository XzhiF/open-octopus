import { describe, it, expect } from 'vitest'
import { matchAppRoute, titleForRoute } from '../routes'
import { resolveUrlTarget, createInitialState, hrefForFocus } from '../desktop-windows'

describe('cabin route matching', () => {
  it('matches /cabin/:cabinId as kind cabin with params', () => {
    const { route, params } = matchAppRoute('/cabin/cabin-123')
    expect(route.kind).toBe('cabin')
    expect(params.cabinId).toBe('cabin-123')
  })

  it('matches /cabin/new (wizard) and titles it', () => {
    const { route, params } = matchAppRoute('/cabin/new')
    expect(route.kind).toBe('cabin')
    expect(titleForRoute(route, params)).toBe('新建作战舱')
  })

  it('does not swallow desktop routes', () => {
    expect(matchAppRoute('/').route.kind).toBe('view')
    expect(matchAppRoute('/tasks').route.kind).toBe('view')
    expect(matchAppRoute('/cabin').route.kind).toBe('not-found')
  })

  it('tolerates trailing slash', () => {
    expect(matchAppRoute('/cabin/cabin-123/').params.cabinId).toBe('cabin-123')
  })
})

describe('desktop windows coexistence with the cabin shell', () => {
  it('resolveUrlTarget recognizes cabin URLs (not a not-found window)', () => {
    const target = resolveUrlTarget('/cabin/cabin-123')
    expect(target).toEqual({ kind: 'cabin', cabinId: 'cabin-123' })
  })

  it('booting on a cabin URL opens no desktop window', () => {
    const state = createInitialState(null, '/cabin/cabin-123', { width: 1400, height: 900 })
    expect(state.order).toHaveLength(0)
    expect(state.focused).toBe('desktop')
  })

  it('focus href stays desktop while the cabin URL is active (no rewrite loop)', () => {
    const state = createInitialState(null, '/cabin/cabin-123', { width: 1400, height: 900 })
    // The provider skips pushUrl when currentKind==='cabin'; hrefForFocus itself
    // still answers the desktop path — the guard is what keeps the URL intact.
    expect(hrefForFocus(state)).toBe('/')
    expect(resolveUrlTarget('/cabin/cabin-123').kind).toBe('cabin')
  })
})