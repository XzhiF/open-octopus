import path from "path"
import { AtomicJsonStore } from "./atomic-json-store"
import { RegistryFileSchema, type ResourceEntry, type ResourceType } from "./types"
import { ResourceError } from "./errors"
import type { RegistryFile } from "./types"

const DEFAULT_REGISTRY: RegistryFile = { version: 1, resources: [] }

/**
 * RegistryStore — CRUD for registry.json with mtime-based cache invalidation.
 */
export class RegistryStore {
  private store: AtomicJsonStore<RegistryFile>
  private cache: RegistryFile | null = null
  private cacheMtime = 0

  constructor(basePath: string) {
    this.store = new AtomicJsonStore(
      path.join(basePath, "registry.json"),
      RegistryFileSchema,
      DEFAULT_REGISTRY,
    )
  }

  private load(): RegistryFile {
    const mtime = this.store.getMtime()
    if (this.cache && mtime === this.cacheMtime) {
      return this.cache
    }
    this.cache = this.store.read()
    this.cacheMtime = mtime
    return this.cache
  }

  private save(data: RegistryFile): void {
    this.store.write(data)
    this.cache = data
    this.cacheMtime = this.store.getMtime()
  }

  list(filter?: { type?: ResourceType; query?: string; installed?: boolean }): ResourceEntry[] {
    const data = this.load()
    let results = data.resources

    if (filter?.type) {
      results = results.filter((r) => r.type === filter.type)
    }
    if (filter?.installed !== undefined) {
      results = results.filter((r) => r.installed === filter.installed)
    }
    if (filter?.query) {
      const q = filter.query.toLowerCase()
      results = results.filter((r) => r.name.toLowerCase().includes(q))
    }

    return results
  }

  get(type: ResourceType, name: string): ResourceEntry | undefined {
    const data = this.load()
    return data.resources.find((r) => r.type === type && r.name === name)
  }

  upsert(entry: ResourceEntry): void {
    const data = this.load()
    const idx = data.resources.findIndex(
      (r) => r.type === entry.type && r.name === entry.name,
    )
    if (idx >= 0) {
      data.resources[idx] = entry
    } else {
      data.resources.push(entry)
    }
    this.save(data)
  }

  /** Batch upsert: read once, apply all entries, write once. O(n) instead of O(n²). */
  batchUpsert(entries: ResourceEntry[]): { inserted: number; updated: number } {
    if (entries.length === 0) return { inserted: 0, updated: 0 }
    const data = this.load()
    let inserted = 0
    let updated = 0
    const index = new Map<string, number>()
    for (let i = 0; i < data.resources.length; i++) {
      index.set(`${data.resources[i].type}:${data.resources[i].name}`, i)
    }
    for (const entry of entries) {
      const key = `${entry.type}:${entry.name}`
      const idx = index.get(key)
      if (idx !== undefined) {
        data.resources[idx] = entry
        updated++
      } else {
        data.resources.push(entry)
        index.set(key, data.resources.length - 1)
        inserted++
      }
    }
    this.save(data)
    return { inserted, updated }
  }

  remove(type: ResourceType, name: string): boolean {
    const data = this.load()
    const idx = data.resources.findIndex(
      (r) => r.type === type && r.name === name,
    )
    if (idx < 0) return false
    data.resources.splice(idx, 1)
    this.save(data)
    return true
  }

  /** Find resources that depend on the given resource */
  findDependents(type: ResourceType, name: string): ResourceEntry[] {
    const data = this.load()
    return data.resources.filter((r) =>
      r.dependsOn.some((d) => d === `${type}:${name}`),
    )
  }

  count(): number {
    return this.load().resources.length
  }

  stats(): {
    total: number
    byType: Record<string, number>
    bySource: Record<string, number>
    byStatus: Record<string, number>
    installed: number
  } {
    const data = this.load()
    const byType: Record<string, number> = {}
    const bySource: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    let installed = 0
    for (const r of data.resources) {
      byType[r.type] = (byType[r.type] ?? 0) + 1
      bySource[r.source] = (bySource[r.source] ?? 0) + 1
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
      if (r.installed) installed++
    }
    return { total: data.resources.length, byType, bySource, byStatus, installed }
  }
}
