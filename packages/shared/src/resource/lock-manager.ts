import path from "path"
import { AtomicJsonStore } from "./atomic-json-store"
import { LockFileSchema, type LockEntry, type ResourceType } from "./types"
import type { LockFile } from "./types"

const DEFAULT_LOCK: LockFile = { version: 1, entries: [] }

/**
 * LockManager — CRUD for resources.lock file.
 * Stores file fingerprints (hash, fileCount) for verify step.
 */
export class LockManager {
  private store: AtomicJsonStore<LockFile>
  private cache: LockFile | null = null
  private cacheMtime = 0

  constructor(basePath: string) {
    this.store = new AtomicJsonStore(
      path.join(basePath, "resources.lock"),
      LockFileSchema,
      DEFAULT_LOCK,
    )
  }

  private load(): LockFile {
    const mtime = this.store.getMtime()
    if (this.cache && mtime === this.cacheMtime) {
      return this.cache
    }
    this.cache = this.store.read()
    this.cacheMtime = mtime
    return this.cache
  }

  private save(data: LockFile): void {
    this.store.write(data)
    this.cache = data
    this.cacheMtime = this.store.getMtime()
  }

  get(type: ResourceType, name: string): LockEntry | undefined {
    const data = this.load()
    return data.entries.find((e) => e.type === type && e.name === name)
  }

  has(type: ResourceType, name: string): boolean {
    return this.get(type, name) !== undefined
  }

  upsert(entry: LockEntry): void {
    const data = this.load()
    const idx = data.entries.findIndex(
      (e) => e.type === entry.type && e.name === entry.name,
    )
    if (idx >= 0) {
      data.entries[idx] = entry
    } else {
      data.entries.push(entry)
    }
    this.save(data)
  }

  /** Batch upsert: read once, apply all entries, write once. */
  batchUpsert(entries: LockEntry[]): void {
    if (entries.length === 0) return
    const data = this.load()
    const index = new Map<string, number>()
    for (let i = 0; i < data.entries.length; i++) {
      index.set(`${data.entries[i].type}:${data.entries[i].name}`, i)
    }
    for (const entry of entries) {
      const key = `${entry.type}:${entry.name}`
      const idx = index.get(key)
      if (idx !== undefined) {
        data.entries[idx] = entry
      } else {
        data.entries.push(entry)
      }
    }
    this.save(data)
  }

  remove(type: ResourceType, name: string): boolean {
    const data = this.load()
    const idx = data.entries.findIndex(
      (e) => e.type === type && e.name === name,
    )
    if (idx < 0) return false
    data.entries.splice(idx, 1)
    this.save(data)
    return true
  }

  list(): LockEntry[] {
    return this.load().entries
  }
}
