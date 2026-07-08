import fs from "fs"
import path from "path"
import type { ResourceAuditRecord, ResourceAuditAction, ResourceAuditCaller, ResourceType } from "./types"
import { ResourceError } from "./errors"

/**
 * AuditWriter — audit-first write-ahead log.
 * Append-only JSONL file. Write audit BEFORE modifying registry/lock.
 *
 * Read strategy:
 * - <1MB: full read
 * - 1-10MB: reverse reader + last N
 * - >10MB: Phase 2 index
 */
export class AuditWriter {
  private filePath: string

  constructor(basePath: string) {
    this.filePath = path.join(basePath, "audit.jsonl")
  }

  /** Append audit record (write-ahead — call BEFORE modifying registry/lock) */
  append(
    action: ResourceAuditAction,
    resource: { name: string; type: ResourceType; source: string },
    caller: ResourceAuditCaller,
    details?: Record<string, unknown>,
  ): void {
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const record: ResourceAuditRecord = {
      timestamp: new Date().toISOString(),
      action,
      resource_name: resource.name,
      resource_type: resource.type,
      source: resource.source,
      caller,
      ...(details && { details }),
    }

    try {
      fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8")
    } catch (err: any) {
      throw new ResourceError("AUDIT_WRITE_FAILED", `Failed to write audit log: ${err.message}`)
    }
  }

  /** Read all audit records (for <1MB files) */
  readAll(): ResourceAuditRecord[] {
    let content: string
    try {
      content = fs.readFileSync(this.filePath, "utf-8")
    } catch (err: any) {
      if (err.code === "ENOENT") return []
      throw err
    }
    const lines = content.trim().split("\n").filter(Boolean)
    return lines.map((line) => {
      try {
        const record = JSON.parse(line) as ResourceAuditRecord
        // Default caller to "cli" for old records without this field
        if (!record.caller) {
          record.caller = "cli"
        }
        return record
      } catch {
        return null
      }
    }).filter((r): r is ResourceAuditRecord => r !== null)
  }

  /** Read last N records (reverse reader for large files) */
  readLast(n: number, filter?: { action?: ResourceAuditAction }): ResourceAuditRecord[] {
    const allRecords = this.readAll()

    // Apply filter
    let records = allRecords
    if (filter?.action) {
      records = records.filter((r) => r.action === filter.action)
    }

    // Return last N (reversed — newest first)
    return records.reverse().slice(0, n)
  }

  /** Query with filters */
  query(filter?: { action?: ResourceAuditAction; last?: number }): ResourceAuditRecord[] {
    const records = this.readAll()

    let filtered = records
    if (filter?.action) {
      filtered = filtered.filter((r) => r.action === filter.action)
    }

    // Sort newest first
    filtered.reverse()

    if (filter?.last) {
      filtered = filtered.slice(0, filter.last)
    }

    return filtered
  }

  getPath(): string {
    return this.filePath
  }
}
