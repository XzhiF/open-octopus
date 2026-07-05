import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import type { AuditEntry } from './schema'

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10 MB
const MAX_ROTATED = 5

export class AuditLogger {
  private logPath: string

  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.logPath = join(dir, 'audit.jsonl')
  }

  append(entry: Omit<AuditEntry, 'timestamp'>): void {
    const full: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    }
    appendFileSync(this.logPath, JSON.stringify(full) + '\n', 'utf-8')
    this.rotateIfNeeded()
  }

  query(filter?: {
    action?: string
    resource?: string
    caller?: string
    since?: string
    limit?: number
  }): AuditEntry[] {
    if (!existsSync(this.logPath)) return []

    const lines = readFileSync(this.logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as AuditEntry } catch { return null }
      })
      .filter((e): e is AuditEntry => e !== null)

    let filtered = lines
    if (filter?.action) {
      filtered = filtered.filter(e => e.action === filter.action)
    }
    if (filter?.resource) {
      filtered = filtered.filter(e => e.resource === filter.resource)
    }
    if (filter?.caller) {
      filtered = filtered.filter(e => e.caller === filter.caller)
    }
    if (filter?.since) {
      filtered = filtered.filter(e => e.timestamp >= filter.since!)
    }

    // Newest first
    filtered.reverse()

    if (filter?.limit && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit)
    }

    return filtered
  }

  private rotateIfNeeded(): void {
    try {
      const s = statSync(this.logPath)
      if (s.size < MAX_LOG_SIZE) return

      // Rotate: audit.jsonl -> audit.jsonl.1 -> .2 -> ... -> .{MAX_ROTATED}
      for (let i = MAX_ROTATED - 1; i >= 1; i--) {
        const src = join(this.dir, `audit.jsonl.${i}`)
        const dst = join(this.dir, `audit.jsonl.${i + 1}`)
        if (existsSync(src)) renameSync(src, dst)
      }
      renameSync(this.logPath, join(this.dir, 'audit.jsonl.1'))
    } catch {
      // Ignore rotation errors
    }
  }
}
