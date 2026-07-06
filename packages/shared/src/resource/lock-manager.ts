import fs from "fs"
import { AtomicJsonStore } from "./atomic-store"
import { ResourceError } from "./errors"
import type { LockFileEntry, ResourceType } from "./types"
import { computeContentHash } from "./utils"

export class LockManager {
  private store: AtomicJsonStore<LockFileEntry[]>

  constructor(filePath: string) {
    this.store = new AtomicJsonStore<LockFileEntry[]>(filePath)
  }

  private load(): LockFileEntry[] {
    return this.store.read([])
  }

  add(entry: LockFileEntry): void {
    const entries = this.load()
    const filtered = entries.filter(e => !(e.name === entry.name && e.type === entry.type))
    this.store.write([...filtered, entry])
  }

  remove(name: string, type: ResourceType): void {
    const entries = this.load()
    this.store.write(entries.filter(e => !(e.name === name && e.type === type)))
  }

  get(name: string, type: ResourceType): LockFileEntry | undefined {
    return this.load().find(e => e.name === name && e.type === type)
  }

  list(): LockFileEntry[] {
    return this.load()
  }

  detectDrift(): Array<{ resource: string; type: ResourceType; issue: "MISSING" | "MODIFIED" | "EXTRA"; expected?: string; actual?: string }> {
    const entries = this.load()
    const drifts: Array<{ resource: string; type: ResourceType; issue: "MISSING" | "MODIFIED" | "EXTRA"; expected?: string; actual?: string }> = []

    for (const entry of entries) {
      if (!fs.existsSync(entry.installPath)) {
        drifts.push({ resource: entry.name, type: entry.type, issue: "MISSING", expected: entry.installPath })
        continue
      }
      try {
        const actualHash = computeContentHash(entry.installPath)
        if (actualHash !== entry.contentHash) {
          drifts.push({ resource: entry.name, type: entry.type, issue: "MODIFIED", expected: entry.contentHash, actual: actualHash })
        }
      } catch {
        drifts.push({ resource: entry.name, type: entry.type, issue: "MISSING", expected: entry.installPath })
      }
    }

    return drifts
  }
}
