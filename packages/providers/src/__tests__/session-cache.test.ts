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

  it('TC-026: resumes session when findSession returns existing', async () => {
    const existingSession = mockSession('existing-session')
    const findSession = vi.fn().mockResolvedValue(existingSession)
    const createSession = vi.fn().mockResolvedValue(mockSession('new-session'))
    cache = new SessionCache({ createSession, findSession })

    const result = await cache.getOrCreate('/cwd', 'resume-id-123')
    expect(findSession).toHaveBeenCalledWith('resume-id-123')
    expect(result).toBe(existingSession)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('TC-027: creates new session when resume target not found', async () => {
    const findSession = vi.fn().mockResolvedValue(null)
    const createSession = vi.fn().mockResolvedValue(mockSession('fallback-session'))
    cache = new SessionCache({ createSession, findSession })

    const result = await cache.getOrCreate('/cwd', 'nonexistent-id')
    expect(findSession).toHaveBeenCalledWith('nonexistent-id')
    expect(createSession).toHaveBeenCalled()
    expect(result.id).toBe('fallback-session')
  })

  it('TC-028: creates new session when findSession throws', async () => {
    const findSession = vi.fn().mockRejectedValue(new Error('corrupted'))
    const createSession = vi.fn().mockResolvedValue(mockSession('fallback-corrupt'))
    cache = new SessionCache({ createSession, findSession })

    const result = await cache.getOrCreate('/cwd', 'corrupt-id')
    expect(findSession).toHaveBeenCalledWith('corrupt-id')
    expect(createSession).toHaveBeenCalled()
    expect(result.id).toBe('fallback-corrupt')
  })

  it('TC-030: throws after dispose and rejects in-flight', async () => {
    let resolvePending: (s: any) => void
    const createSession = vi.fn().mockImplementation(() =>
      new Promise((resolve) => { resolvePending = resolve }),
    )
    cache = new SessionCache({ createSession, findSession: vi.fn().mockResolvedValue(null) })

    // Start a pending creation
    const pendingPromise = cache.getOrCreate('/cwd')
    // Dispose before it resolves
    cache.dispose()
    // Resolve the pending one
    resolvePending!(mockSession('late-session'))
    await pendingPromise // this one still completes

    // New requests after dispose should throw
    await expect(cache.getOrCreate('/cwd2')).rejects.toThrow('Provider disposed')
  })
})
