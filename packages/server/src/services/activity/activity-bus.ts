import { randomUUID } from "crypto"

export type ActivitySeverity = "info" | "warn" | "critical"

export type ActivityKind =
  | "workflow.started"
  | "workflow.node_failed"
  | "workflow.approval"
  | "workflow.paused"
  | "workflow.completed"
  | "workflow.failed"
  | "workflow.stalled"
  | "task.started"
  | "task.status"
  | "task.review"
  | "task.completed"
  | "task.failed"

export interface ActivityEvent {
  id: string
  kind: ActivityKind
  severity: ActivitySeverity
  title: string
  message?: string
  workspaceId?: string | null
  executionId?: string | null
  taskId?: string | null
  sessionId?: string | null
  nodeId?: string | null
  createdAt: string
  payload?: Record<string, unknown>
}

export interface ActivityQuery {
  workspaceId?: string | null
  limit?: number
}

type ActivityListener = (event: ActivityEvent) => void

/**
 * In-memory fan-out for cross-domain activity (workflows, tasks, agents).
 * Deliberately not persisted: it feeds the live dock / wake bridge, while
 * workflow + task rows remain the durable source of truth.
 */
class ActivityBus {
  private listeners = new Set<ActivityListener>()
  private recent: ActivityEvent[] = []
  private readonly maxRecent = 200

  publish(input: Omit<ActivityEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): ActivityEvent {
    const event: ActivityEvent = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
    }
    this.recent.push(event)
    if (this.recent.length > this.maxRecent) {
      this.recent = this.recent.slice(-this.maxRecent)
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch (err) {
        console.error("[ActivityBus] listener error:", err instanceof Error ? err.message : String(err))
      }
    }
    return event
  }

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(query?: ActivityQuery): ActivityEvent[] {
    let events = this.recent
    if (query?.workspaceId) {
      events = events.filter((e) => e.workspaceId === query.workspaceId)
    }
    const limit = Math.min(Math.max(query?.limit ?? 50, 1), 200)
    return events.slice(-limit)
  }
}

const bus = new ActivityBus()

export function getActivityBus(): ActivityBus {
  return bus
}
