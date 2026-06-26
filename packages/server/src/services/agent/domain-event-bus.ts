// ── Event Types ─────────────────────────────────────────────────────

export type DomainEventType =
  | 'orchestration.intent_classified'
  | 'orchestration.workflow_selected'
  | 'orchestration.workflow_generated'
  | 'orchestration.execution_started'
  | 'orchestration.execution_completed'
  | 'orchestration.execution_failed'
  | 'clone.created'
  | 'clone.delegated'
  | 'clone.merged'
  | 'clone.deleted'
  | 'session.created'
  | 'session.message_sent'
  | 'session.compressed'
  | 'memory.archived'
  | 'memory.refined'
  | 'evolution.skill_evolved'
  | 'evolution.rollback'
  | 'evolution.feedback_received'
  | 'safety.event_detected'
  | 'safety.safe_mode_toggled'
  | 'scheduler.job_registered'
  | 'scheduler.job_executed'
  | 'scheduler.job_failed'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'archive.execution_completed'
  | 'archive.workspace_archived'

export interface DomainEvent<T = unknown> {
  type: DomainEventType
  data: T
  timestamp: string
  source: string
  correlation_id?: string
}

export type DomainEventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>

// ── DomainEventBus ──────────────────────────────────────────────────

/**
 * EventEmitter-based domain event bus for fan-out of safety, task,
 * evolution, and orchestration events to parallel handlers.
 * Maps to PRD P3.4: Domain Event Bus pattern.
 */
export class DomainEventBus {
  private handlers: Map<DomainEventType, DomainEventHandler[]>
  private history: DomainEvent[]
  private maxHistory: number

  constructor(maxHistory = 1000) {
    this.handlers = new Map()
    this.history = []
    this.maxHistory = maxHistory
  }

  /**
   * Subscribe to a specific event type.
   */
  on<T = unknown>(type: DomainEventType, handler: DomainEventHandler<T>): () => void {
    const existing = this.handlers.get(type) ?? []
    existing.push(handler as DomainEventHandler)
    this.handlers.set(type, existing)

    // Return unsubscribe function
    return () => {
      const current = this.handlers.get(type) ?? []
      this.handlers.set(type, current.filter(h => h !== handler))
    }
  }

  /**
   * Subscribe to a specific event type (one-time).
   */
  once<T = unknown>(type: DomainEventType, handler: DomainEventHandler<T>): void {
    const wrappedHandler: DomainEventHandler<T> = async (event) => {
      await handler(event)
      this.handlers.set(type, (this.handlers.get(type) ?? []).filter(h => h !== wrappedHandler))
    }
    this.on(type, wrappedHandler)
  }

  /**
   * Emit a domain event to all registered handlers.
   * Events are dispatched asynchronously; handler errors are caught and logged.
   */
  async emit<T = unknown>(
    type: DomainEventType,
    data: T,
    opts?: { source?: string; correlation_id?: string },
  ): Promise<void> {
    const event: DomainEvent<T> = {
      type,
      data,
      timestamp: new Date().toISOString(),
      source: opts?.source ?? 'unknown',
      correlation_id: opts?.correlation_id,
    }

    // Append to history ring buffer
    this.history.push(event as DomainEvent)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }

    // Dispatch to all handlers (parallel, error-isolated)
    const handlers = this.handlers.get(type) ?? []
    const promises = handlers.map(async (handler) => {
      try {
        await handler(event as DomainEvent)
      } catch (err) {
        // Handler error is non-fatal — log but don't break the bus
        if (process.env.NODE_ENV !== 'test') {
          process.stderr.write(
            `[DomainEventBus] Handler error for ${type}: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    })

    await Promise.allSettled(promises)
  }

  /**
   * Get recent event history (ring buffer, most recent last).
   */
  getHistory(opts?: { type?: DomainEventType; limit?: number }): DomainEvent[] {
    let events = this.history
    if (opts?.type) {
      events = events.filter(e => e.type === opts.type)
    }
    if (opts?.limit) {
      events = events.slice(-opts.limit)
    }
    return events
  }

  /**
   * Get count of registered handlers per event type.
   */
  handlerCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const [type, handlers] of this.handlers) {
      counts[type] = handlers.length
    }
    return counts
  }

  /**
   * Remove all handlers and clear history.
   */
  reset(): void {
    this.handlers.clear()
    this.history = []
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: DomainEventBus | null = null

export function getDomainEventBus(): DomainEventBus {
  if (!instance) {
    instance = new DomainEventBus()
  }
  return instance
}
