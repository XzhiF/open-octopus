import Database from "better-sqlite3"
import { ExecutionDAO, ScheduleRunDAO, ArchiveDAO } from "../db/dao"
import { DataRetentionService } from "./data-retention"
import type { ExperienceLifecycleService } from "./experience-lifecycle"

export interface ErrorRecord {
  id: string
  timestamp: number
  message: string
  stack?: string
  context: Record<string, unknown>
  category: 'execution' | 'observability' | 'api' | 'provider' | 'unknown'
}

export class ErrorTracker {
  private errors: ErrorRecord[] = []
  private maxEntries = 1000

  capture(category: ErrorRecord['category'], message: string, context: Record<string, unknown> = {}): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const record: ErrorRecord = { id, timestamp: Date.now(), message, context, category }
    this.errors.push(record)
    if (this.errors.length > this.maxEntries) {
      this.errors = this.errors.slice(-this.maxEntries)
    }
    return id
  }

  getErrors(since?: number, category?: ErrorRecord['category']): ErrorRecord[] {
    let filtered = this.errors
    if (since) filtered = filtered.filter(e => e.timestamp >= since)
    if (category) filtered = filtered.filter(e => e.category === category)
    return filtered
  }

  getAggregates(): { total: number; byCategory: Record<string, number>; recent10: ErrorRecord[] } {
    const byCategory: Record<string, number> = {}
    for (const e of this.errors) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
    }
    return { total: this.errors.length, byCategory, recent10: this.errors.slice(-10).reverse() }
  }

  clear(): void { this.errors = [] }

  getRecentErrors(limit: number): ErrorRecord[] {
    return this.errors.slice(-limit).reverse()
  }
}

export const globalErrorTracker = new ErrorTracker()

export function setupDataRetention(
  db: Database.Database,
  opts?: { archiveDAO?: ArchiveDAO; lifecycleSvc?: ExperienceLifecycleService },
): () => void {
  const execDAO = new ExecutionDAO(db)
  const runDAO = new ScheduleRunDAO(db)
  const service = new DataRetentionService(execDAO, runDAO, opts?.archiveDAO, opts?.lifecycleSvc)
  return service.start()
}
