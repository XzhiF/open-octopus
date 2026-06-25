type SSEEvent = {
  event: string
  data: unknown
}

type Listener = (event: SSEEvent) => void

// High-frequency events that would flood the console — skip logging for these
const SILENT_EVENTS = new Set([
  "agent_event", "node_log", "execution_progress",
  "expert_spawn", "expert_message", "expert_complete",
  "consensus_check", "swarm_round_end", "swarm_complete",
])

export class SSEService {
  private listeners = new Map<string, Set<Listener>>()
  private ringBuffer: SSEEvent[] = []
  private readonly maxBufferSize = 500

  subscribe(workspaceId: string, listener: Listener): () => void {
    if (!this.listeners.has(workspaceId)) {
      this.listeners.set(workspaceId, new Set())
    }
    this.listeners.get(workspaceId)!.add(listener)
    return () => {
      const set = this.listeners.get(workspaceId)
      if (set) {
        set.delete(listener)
        if (set.size === 0) this.listeners.delete(workspaceId)
      }
    }
  }

  emit(workspaceId: string, event: SSEEvent): void {
    const set = this.listeners.get(workspaceId)
    if (!SILENT_EVENTS.has(event.event)) {
      console.log(`[sse] emit event=${event.event} listeners=${set?.size ?? 0}`)
    }
    if (!set) return
    for (const listener of set) {
      try { listener(event) } catch (e) { console.error(`[sse] listener error:`, e) }
    }
    this.ringBuffer.push(event)
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer = this.ringBuffer.slice(-this.maxBufferSize)
    }
  }

  emitToAll(event: SSEEvent): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) {
        try { listener(event) } catch { /* ignore */ }
      }
    }
  }

  getMissedEvents(_sinceOrder?: number): SSEEvent[] {
    return [...this.ringBuffer]
  }

  clearBuffer(): void { this.ringBuffer = [] }
}