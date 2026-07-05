import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, createReadStream, createWriteStream } from 'fs'
import { join } from 'path'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
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

      // F9: Rotate + gzip compress oldest archive
      // Remove oldest (compressed or not)
      const oldestGz = join(this.dir, `audit.jsonl.${MAX_ROTATED}.gz`)
      const oldestRaw = join(this.dir, `audit.jsonl.${MAX_ROTATED}`)
      if (existsSync(oldestGz)) unlinkSync(oldestGz)
      if (existsSync(oldestRaw)) unlinkSync(oldestRaw)

      // Shift numbered archives
      for (let i = MAX_ROTATED - 1; i >= 1; i--) {
        const srcGz = join(this.dir, `audit.jsonl.${i}.gz`)
        const srcRaw = join(this.dir, `audit.jsonl.${i}`)
        const dstGz = join(this.dir, `audit.jsonl.${i + 1}.gz`)
        const dstRaw = join(this.dir, `audit.jsonl.${i + 1}`)
        if (existsSync(srcGz)) renameSync(srcGz, dstGz)
        else if (existsSync(srcRaw)) renameSync(srcRaw, dstRaw)
      }

      // Rotate current → .1 and gzip compress it
      const rotated = join(this.dir, 'audit.jsonl.1')
      renameSync(this.logPath, rotated)
      // F9: Compress the rotated file to .gz
      this.compressFile(rotated, rotated + '.gz').catch(() => {})
    } catch {
      // Ignore rotation errors
    }
  }

  /**
   * F9: Gzip compress a file asynchronously
   */
  private async compressFile(src: string, dst: string): Promise<void> {
    try {
      await pipeline(
        createReadStream(src),
        createGzip(),
        createWriteStream(dst),
      )
      unlinkSync(src)
    } catch {
      // Keep uncompressed if compression fails
    }
  }
}
