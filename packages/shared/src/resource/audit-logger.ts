import fs from "fs"
import path from "path"
import crypto from "crypto"
import type { AuditEntry, ResourceType } from "./types"

export interface AuditFilter {
  action?: AuditEntry["action"]
  resource?: string
  last?: number
}

export class AuditLogger {
  private filePath: string
  private lastHash: string = ""

  constructor(filePath: string) {
    this.filePath = filePath
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // Load last hash from existing log
    this.lastHash = this.computeLastHash()
  }

  private computeLastHash(): string {
    if (!fs.existsSync(this.filePath)) return ""
    try {
      const lines = fs.readFileSync(this.filePath, "utf-8").trim().split("\n").filter(Boolean)
      if (lines.length === 0) return ""
      const lastLine = lines[lines.length - 1]
      const lastEntry = JSON.parse(lastLine) as AuditEntry
      return crypto.createHash("sha256").update(lastLine).digest("hex")
    } catch {
      return ""
    }
  }

  log(entry: Omit<AuditEntry, "timestamp" | "prevHash">): void {
    const full: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      prevHash: this.lastHash || undefined,
    }
    const line = JSON.stringify(full)
    fs.appendFileSync(this.filePath, line + "\n", "utf-8")
    this.lastHash = crypto.createHash("sha256").update(line).digest("hex")
  }

  read(filter?: AuditFilter): AuditEntry[] {
    if (!fs.existsSync(this.filePath)) return []
    try {
      const lines = fs.readFileSync(this.filePath, "utf-8").trim().split("\n").filter(Boolean)
      let entries = lines.map(l => JSON.parse(l) as AuditEntry).reverse()
      if (filter?.action) entries = entries.filter(e => e.action === filter.action)
      if (filter?.resource) entries = entries.filter(e => e.resource === filter.resource)
      if (filter?.last) entries = entries.slice(0, filter.last)
      return entries
    } catch {
      return []
    }
  }

  export(since?: string, limit = 10000): AuditEntry[] {
    if (!fs.existsSync(this.filePath)) return []
    try {
      const lines = fs.readFileSync(this.filePath, "utf-8").trim().split("\n").filter(Boolean)
      let entries = lines.map(l => JSON.parse(l) as AuditEntry)
      if (since) {
        const sinceDate = new Date(since)
        entries = entries.filter(e => new Date(e.timestamp) >= sinceDate)
      }
      if (entries.length > limit) {
        throw new Error(`Export limited to ${limit} entries. Use 'since' parameter to narrow the range.`)
      }
      return entries
    } catch (err) {
      if (err instanceof Error && err.message.includes("Export limited")) throw err
      return []
    }
  }
}
