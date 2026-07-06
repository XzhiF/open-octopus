import { AtomicJsonStore } from "./atomic-store"
import { ResourceError } from "./errors"
import type { RegistryEntry, ResourceType, ResourceManifest } from "./types"
import { RegistryEntrySchema } from "./types"
import { formatSourceRef } from "./utils"

export interface RegistryFilter {
  type?: ResourceType
  installed?: boolean
  query?: string
  tag?: string
}

export class RegistryStore {
  private store: AtomicJsonStore<RegistryEntry[]>
  private cache: RegistryEntry[] | null = null

  constructor(filePath: string) {
    this.store = new AtomicJsonStore<RegistryEntry[]>(filePath)
  }

  private load(): RegistryEntry[] {
    if (this.cache) return this.cache
    this.cache = this.store.read([])
    return this.cache
  }

  register(manifest: ResourceManifest): RegistryEntry {
    const entries = this.load()
    const existing = entries.find(e => e.name === manifest.name && e.type === manifest.type)
    const now = new Date().toISOString()

    if (existing) {
      // Idempotent update
      const updated: RegistryEntry = {
        ...existing,
        version: manifest.version,
        description: manifest.description,
        source: manifest.source,
        dependencies: manifest.dependencies,
        tags: manifest.tags,
        updatedAt: now,
      }
      const next = entries.map(e => e.name === manifest.name && e.type === manifest.type ? updated : e)
      this.store.write(next)
      this.cache = null  // R2: invalidate cache after write
      return updated
    }

    const entry: RegistryEntry = {
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
      description: manifest.description,
      source: manifest.source,
      installed: false,
      dependencies: manifest.dependencies,
      tags: manifest.tags,
      createdAt: now,
      updatedAt: now,
    }
    const validated = RegistryEntrySchema.parse(entry)
    this.store.write([...entries, validated])
    this.cache = null  // R2: invalidate cache after write
    return validated
  }

  unregister(name: string, type: ResourceType): void {
    const entries = this.load()
    const next = entries.filter(e => !(e.name === name && e.type === type))
    this.store.write(next)
    this.cache = null  // R2: invalidate cache after write
  }

  get(name: string, type: ResourceType): RegistryEntry | undefined {
    return this.load().find(e => e.name === name && e.type === type)
  }

  list(filter?: RegistryFilter): RegistryEntry[] {
    let result = this.load()
    if (filter?.type) result = result.filter(e => e.type === filter.type)
    if (filter?.installed !== undefined) result = result.filter(e => e.installed === filter.installed)
    if (filter?.query) {
      const q = filter.query.toLowerCase()
      result = result.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q)
      )
    }
    if (filter?.tag) result = result.filter(e => e.tags?.includes(filter.tag as string))
    return result
  }

  search(query: string): RegistryEntry[] {
    return this.list({ query })
  }

  updateInstalled(name: string, type: ResourceType, installed: boolean, installPath?: string, contentHash?: string): void {
    const entries = this.load()
    const now = new Date().toISOString()
    const next = entries.map(e => {
      if (e.name === name && e.type === type) {
        return { ...e, installed, installPath, contentHash, updatedAt: now }
      }
      return e
    })
    this.store.write(next)
    this.cache = null  // R2: invalidate cache after write
  }
}
