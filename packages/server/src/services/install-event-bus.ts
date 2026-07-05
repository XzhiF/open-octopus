export interface InstallEvent {
  id: string
  installId: string
  type: 'start' | 'progress' | 'complete' | 'error'
  resource: string
  message: string
  timestamp: string
  progress?: number
}

type Listener = (event: InstallEvent) => void

/**
 * InstallEventBus — per-installId 事件缓冲 + 回放
 *
 * PRD §9.3: 每个 install 操作有独立的 installId，
 * SSE 连接按 installId 订阅，避免多并发安装事件混淆。
 *
 * - 5 分钟超时自动清理
 * - 每个 installId 最多缓冲 500 事件
 * - 最多同时 50 个活跃安装
 */
export class InstallEventBus {
  private buffers = new Map<string, InstallEvent[]>()
  private listeners = new Map<string, Set<Listener>>()
  private maxBufferPerInstall = 500
  private maxActiveInstalls = 50
  private ttlMs = 5 * 60 * 1000 // 5 min
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor() {
    // Periodic cleanup of expired installs
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  emit(installId: string, event: Omit<InstallEvent, 'id' | 'timestamp' | 'installId'>): void {
    const full: InstallEvent = {
      ...event,
      installId,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    }

    // Buffer events per installId
    let buf = this.buffers.get(installId)
    if (!buf) {
      buf = []
      this.buffers.set(installId, buf)
      // Enforce max active installs (evict oldest)
      if (this.buffers.size > this.maxActiveInstalls) {
        const oldest = this.buffers.keys().next().value
        if (oldest) this.removeInstall(oldest)
      }
    }
    buf.push(full)
    if (buf.length > this.maxBufferPerInstall) {
      this.buffers.set(installId, buf.slice(-this.maxBufferPerInstall))
    }

    // Notify listeners for this installId
    const installListeners = this.listeners.get(installId)
    if (installListeners) {
      for (const listener of installListeners) {
        listener(full)
      }
    }
  }

  subscribe(installId: string, listener: Listener): () => void {
    let set = this.listeners.get(installId)
    if (!set) {
      set = new Set()
      this.listeners.set(installId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.listeners.delete(installId)
    }
  }

  replay(installId: string, since?: string): InstallEvent[] {
    const buf = this.buffers.get(installId) ?? []
    if (!since) return [...buf]
    return buf.filter(e => e.timestamp >= since)
  }

  /**
   * Check if an install is currently active (has buffered events)
   */
  isActive(installId: string): boolean {
    return this.buffers.has(installId)
  }

  removeInstall(installId: string): void {
    this.buffers.delete(installId)
    this.listeners.delete(installId)
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [installId, buf] of this.buffers) {
      if (buf.length === 0) {
        this.removeInstall(installId)
        continue
      }
      // Check if the latest event is older than TTL
      const latest = buf[buf.length - 1]
      if (new Date(latest.timestamp).getTime() < cutoff) {
        this.removeInstall(installId)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
    this.buffers.clear()
    this.listeners.clear()
  }
}
