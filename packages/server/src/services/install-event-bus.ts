export interface InstallEvent {
  id: string
  type: 'start' | 'progress' | 'complete' | 'error'
  resource: string
  message: string
  timestamp: string
  progress?: number
}

export class InstallEventBus {
  private buffer: InstallEvent[] = []
  private maxBuffer = 1000
  private listeners = new Set<(event: InstallEvent) => void>()

  emit(event: Omit<InstallEvent, 'id' | 'timestamp'>): void {
    const full: InstallEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    }
    this.buffer.push(full)
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer)
    }
    for (const listener of this.listeners) {
      listener(full)
    }
  }

  subscribe(listener: (event: InstallEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replay(since?: string): InstallEvent[] {
    if (!since) return [...this.buffer]
    return this.buffer.filter(e => e.timestamp >= since)
  }

  clear(): void {
    this.buffer = []
  }
}
