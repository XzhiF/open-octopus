import type { SessionResult } from './pi-sdk-adapter'

export interface SessionFactoryOptions {
  filteredEnv?: Record<string, string>
  subAgentTools?: any[]
  systemPrompt?: string
  skills?: string[]
}

type SessionFactory = (cwd: string, resumeSessionId?: string, options?: SessionFactoryOptions) => Promise<SessionResult>

interface CacheEntry {
  result: SessionResult
  lastAccessed: number
}

interface SessionCacheOptions {
  maxSessions?: number
  idleTimeoutMs?: number
}

export class SessionCache {
  private cache = new Map<string, CacheEntry>()
  private locks = new Map<string, Promise<void>>()
  private inflight = new Map<string, Promise<SessionResult>>()  // BL-2: deduplicate concurrent creates
  private factory: SessionFactory
  private maxSessions: number
  private idleTimeoutMs: number
  private idleTimer: ReturnType<typeof setInterval> | null = null  // P1-3

  constructor(factory: SessionFactory, opts?: SessionCacheOptions) {
    this.factory = factory
    this.maxSessions = opts?.maxSessions ?? 10
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 30 * 60 * 1000
    this.startIdleTimer()  // P1-3: schedule periodic idle eviction
  }

  /** P1-3: Start periodic idle session eviction timer */
  private startIdleTimer(): void {
    if (this.idleTimer) return
    // Check every idleTimeoutMs/2 for expired sessions
    const intervalMs = Math.max(this.idleTimeoutMs / 2, 60_000) // min 1 minute
    this.idleTimer = setInterval(() => this.evictIdle(), intervalMs)
    // Allow Node.js process to exit even if timer is active
    if (this.idleTimer && typeof this.idleTimer === 'object' && 'unref' in this.idleTimer) {
      this.idleTimer.unref()
    }
  }

  async getOrCreate(cwd: string, resumeSessionId?: string, options?: SessionFactoryOptions): Promise<SessionResult> {
    const key = resumeSessionId ? `${cwd}:${resumeSessionId}` : cwd
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccessed = Date.now()
      return entry.result
    }
    // BL-2: Deduplicate concurrent session creation for the same key
    const existingInflight = this.inflight.get(key)
    if (existingInflight) return existingInflight

    const createPromise = this._createAndCache(key, cwd, resumeSessionId, options)
    this.inflight.set(key, createPromise)
    try {
      return await createPromise
    } finally {
      this.inflight.delete(key)
    }
  }

  private async _createAndCache(
    key: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SessionFactoryOptions,
  ): Promise<SessionResult> {
    this.evictIfNeeded()
    const result = await this.factory(cwd, resumeSessionId, options)
    this.cache.set(key, { result, lastAccessed: Date.now() })
    return result
  }

  async withSession<T>(key: string, fn: (session: SessionResult) => Promise<T>): Promise<T> {
    const sessionResult = await this.getOrCreate(key)
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(() => fn(sessionResult), () => fn(sessionResult))
    this.locks.set(key, next.then(() => {}, () => {}))
    return next
  }

  private evictIfNeeded(): void {
    while (this.cache.size >= this.maxSessions) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, entry] of this.cache) {
        if (entry.lastAccessed < oldestTime) {
          oldestTime = entry.lastAccessed
          oldestKey = key
        }
      }
      if (oldestKey) {
        this.disposeEntry(oldestKey)
      } else {
        break
      }
    }
  }

  evictIdle(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now - entry.lastAccessed > this.idleTimeoutMs) {
        this.disposeEntry(key)
      }
    }
  }

  private disposeEntry(key: string): void {
    const entry = this.cache.get(key)
    if (entry) {
      try { (entry.result.session as any)?.dispose?.() } catch { /* ignore */ }
      this.cache.delete(key)
      this.locks.delete(key)
    }
  }

  getSessionId(session: SessionResult): string {
    return session.sessionId
  }

  dispose(): void {
    // P1-3: Clear idle eviction timer
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    for (const [key] of this.cache) {
      this.disposeEntry(key)
    }
  }
}
