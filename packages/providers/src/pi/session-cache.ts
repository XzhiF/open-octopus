interface SessionLike {
  dispose(): void | Promise<void>
}

interface SessionCacheOptions {
  createSession: (cwd: string, options?: any) => Promise<SessionLike>
  findSession: (resumeId: string) => Promise<SessionLike | null>
}

export class SessionCache {
  private cache = new Map<string, SessionLike>()
  private pending = new Map<string, Promise<SessionLike>>()
  private disposed = false

  readonly createSessionFn: (cwd: string, options?: any) => Promise<SessionLike>
  readonly findSessionFn: (resumeId: string) => Promise<SessionLike | null>

  constructor(opts: SessionCacheOptions) {
    this.createSessionFn = opts.createSession
    this.findSessionFn = opts.findSession
  }

  async getOrCreate(
    cwd: string,
    resumeSessionId?: string,
    options?: any,
    swarmContext?: { expertName?: string },
  ): Promise<SessionLike> {
    if (this.disposed) {
      throw new Error('Provider disposed')
    }

    const key = this.cacheKey(cwd, resumeSessionId, swarmContext)
    const cached = this.cache.get(key)
    if (cached) return cached

    const pending = this.pending.get(key)
    if (pending) return pending

    const creation = this.create(cwd, resumeSessionId, options)
    this.pending.set(key, creation)

    try {
      const session = await creation
      this.cache.set(key, session)
      return session
    } finally {
      this.pending.delete(key)
    }
  }

  private async create(cwd: string, resumeId?: string, options?: any): Promise<SessionLike> {
    if (resumeId) {
      try {
        const existing = await this.findSessionFn(resumeId)
        if (existing) return existing
      } catch {
        // Resume failed — degrade to new session
      }
    }
    return this.createSessionFn(cwd, options)
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.cache.values()) {
      try { session.dispose() } catch { /* best-effort */ }
    }
    this.cache.clear()
  }

  private cacheKey(cwd: string, resumeId?: string, swarm?: { expertName?: string }): string {
    if (swarm?.expertName) return `${cwd}:swarm:${swarm.expertName}`
    return `${cwd}:${resumeId ?? 'new'}`
  }
}
