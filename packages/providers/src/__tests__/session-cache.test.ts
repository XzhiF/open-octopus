import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionCache } from '../pi/session-cache'

function mockSession(id: string) {
  return { id, dispose: vi.fn() }
}

describe('SessionCache', () => {
  let cache: SessionCache

  beforeEach(() => {
    cache = new SessionCache({
      createSession: vi.fn().mockResolvedValue(mockSession('session-1')),
      findSession: vi.fn().mockResolvedValue(null),
    })
  })

  it('creates and caches session for same cwd', async () => {
    const s1 = await cache.getOrCreate('/project-a')
    const s2 = await cache.getOrCreate('/project-a')
    expect(s1).toBe(s2)
    expect(cache.createSessionFn).toHaveBeenCalledTimes(1)
  })

  it('isolates sessions by cwd', async () => {
    cache = new SessionCache({
      createSession: vi.fn()
        .mockResolvedValueOnce(mockSession('s-a'))
        .mockResolvedValueOnce(mockSession('s-b')),
      findSession: vi.fn().mockResolvedValue(null),
    })
    const s1 = await cache.getOrCreate('/project-a')
    const s2 = await cache.getOrCreate('/project-b')
    expect(s1).not.toBe(s2)
  })

  it('disposes all sessions', async () => {
    const session = await cache.getOrCreate('/project-a')
    cache.dispose()
    expect(session.dispose).toHaveBeenCalled()
  })

  it('prevents concurrent creation for same cwd', async () => {
    const [s1, s2] = await Promise.all([
      cache.getOrCreate('/project-a'),
      cache.getOrCreate('/project-a'),
    ])
    expect(s1).toBe(s2)
    expect(cache.createSessionFn).toHaveBeenCalledTimes(1)
  })

  it('uses swarm context in cache key', async () => {
    cache = new SessionCache({
      createSession: vi.fn()
        .mockResolvedValueOnce(mockSession('s-default'))
        .mockResolvedValueOnce(mockSession('s-expert')),
      findSession: vi.fn().mockResolvedValue(null),
    })
    const s1 = await cache.getOrCreate('/cwd')
    const s2 = await cache.getOrCreate('/cwd', undefined, undefined, { expertName: 'researcher' })
    expect(s1).not.toBe(s2)
  })
})
