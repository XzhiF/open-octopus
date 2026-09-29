import { describe, it, expect, vi } from 'vitest'
import { SessionCache } from '../../pi/session-cache'

// b810036e changed the cache contract: getOrCreate WITHOUT resumeSessionId
// always creates a fresh session (prevents cross-workflow conversation
// history contamination). Cache reuse/eviction now only applies to
// resume-keyed entries (key = cwd:resumeSessionId).

describe('SessionCache', () => {
  it('reuses cached session for same cwd + resumeSessionId (TC-021)', async () => {
    let createCount = 0
    const mockFactory = async (cwd: string) => {
      createCount++
      return { session: { id: `session-${createCount}` }, sessionId: `session-${createCount}`, modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)

    const result1 = await cache.getOrCreate('/project-a', 'resume-1')
    const result2 = await cache.getOrCreate('/project-a', 'resume-1')
    expect(result1).toBe(result2)
    expect(createCount).toBe(1)
  })

  it('without resumeSessionId always creates a fresh session (b810036e)', async () => {
    let createCount = 0
    const mockFactory = async (cwd: string) => {
      createCount++
      return { session: { id: `session-${createCount}` }, sessionId: `session-${createCount}`, modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)

    const result1 = await cache.getOrCreate('/project-a')
    const result2 = await cache.getOrCreate('/project-a')
    expect(result1).not.toBe(result2)
    expect(createCount).toBe(2)
  })

  it('different resumeSessionId creates new session (TC-022)', async () => {
    let createCount = 0
    const mockFactory = async (cwd: string, resumeId?: string) => {
      createCount++
      return { session: { id: `session-${createCount}` }, sessionId: `session-${createCount}`, modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)

    await cache.getOrCreate('/project-a')
    await cache.getOrCreate('/project-a', 'session-123')
    expect(createCount).toBe(2)
  })

  it('withSession serializes access (E-3)', async () => {
    let createCount = 0
    const mockFactory = async (cwd: string) => {
      createCount++
      return { session: { id: `session-${createCount}` }, sessionId: `session-${createCount}`, modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)

    const order: number[] = []
    const task1 = cache.withSession('/p', async () => {
      await new Promise(r => setTimeout(r, 10))
      order.push(1)
      return 'a'
    })
    const task2 = cache.withSession('/p', async () => {
      order.push(2)
      return 'b'
    })

    const [r1, r2] = await Promise.all([task1, task2])
    expect(r1).toBe('a')
    expect(r2).toBe('b')
    expect(order).toEqual([1, 2])
  })

  it('dispose clears all cached sessions', async () => {
    const disposed: string[] = []
    const mockFactory = async (cwd: string) => ({
      session: { id: cwd, dispose: () => disposed.push(cwd) },
      sessionId: cwd,
      modelRegistry: null,
    })
    const cache = new SessionCache(mockFactory)
    await cache.getOrCreate('/a', 'r-a')
    await cache.getOrCreate('/b', 'r-b')
    cache.dispose()
    expect(disposed).toContain('/a')
    expect(disposed).toContain('/b')
  })

  it('P1-3: evicts LRU when exceeding maxSessions', async () => {
    const disposed: string[] = []
    const mockFactory = async (cwd: string) => ({
      session: { id: cwd, dispose: () => disposed.push(cwd) },
      sessionId: cwd,
      modelRegistry: null,
    })
    const cache = new SessionCache(mockFactory, { maxSessions: 2 })
    await cache.getOrCreate('/a', 'r-a')
    await cache.getOrCreate('/b', 'r-b')
    await cache.getOrCreate('/c', 'r-c')
    expect(disposed).toContain('/a')
    expect(disposed).not.toContain('/b')
    expect(disposed).not.toContain('/c')
  })

  it('P1-3: idle timeout disposes expired sessions', async () => {
    vi.useFakeTimers()
    const disposed: string[] = []
    const mockFactory = async (cwd: string) => ({
      session: { id: cwd, dispose: () => disposed.push(cwd) },
      sessionId: cwd,
      modelRegistry: null,
    })
    const cache = new SessionCache(mockFactory, { idleTimeoutMs: 1000 })
    await cache.getOrCreate('/idle', 'r-idle')
    vi.advanceTimersByTime(1500)
    cache.evictIdle()
    expect(disposed).toContain('/idle')
    vi.useRealTimers()
  })

  it('BL-2: deduplicates concurrent session creation for same key', async () => {
    let createCount = 0
    let resolveFactory: (() => void) | null = null
    const mockFactory = async (cwd: string) => {
      createCount++
      // Simulate slow factory — both calls should hit inflight
      await new Promise<void>(r => { resolveFactory = r })
      return { session: { id: cwd }, sessionId: cwd, modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)

    const p1 = cache.getOrCreate('/concurrent', 'r-conc')
    const p2 = cache.getOrCreate('/concurrent', 'r-conc')

    // Resolve the (single) factory invocation
    resolveFactory!()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2) // Same session object
    expect(createCount).toBe(1) // Factory called only once
  })
})
