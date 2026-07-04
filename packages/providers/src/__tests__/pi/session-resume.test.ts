import { describe, it, expect } from 'vitest'
import { SessionCache } from '../../pi/session-cache'

describe('Session Resume (S16, P2-5)', () => {
  it('resumeSessionId creates new cache key (TC-038)', async () => {
    let createCount = 0
    const mockFactory = async (cwd: string, resumeId?: string) => {
      createCount++
      return {
        session: { id: `session-${createCount}`, state: { messages: resumeId ? [{ role: 'user', content: 'previous' }] : [] } },
        sessionId: resumeId ?? `new-${createCount}`,
        modelRegistry: null,
      }
    }
    const cache = new SessionCache(mockFactory)

    const s1 = await cache.getOrCreate('/project')
    expect(s1.session.state.messages).toEqual([])

    const s2 = await cache.getOrCreate('/project', 'prev-session')
    expect(s2.session.state.messages.length).toBeGreaterThan(0)
    expect(createCount).toBe(2)
  })

  it('resumeSessionId not found falls back to new session (TC-039)', async () => {
    const mockFactory = async (cwd: string, resumeId?: string) => {
      return { session: { id: 'fallback-new', state: { messages: [] } }, sessionId: 'fallback-new', modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)
    const s = await cache.getOrCreate('/project', 'nonexistent-id')
    expect(s.session.id).toBe('fallback-new')
  })
})
