import type { RegistryEntry, ResourceType, Registry } from "@octopus/shared"
import { RegistrySchema, AtomicJsonStore, registryKey } from "@octopus/shared"
import path from "path"

export class RegistryStore {
  private store: AtomicJsonStore<Registry>
  private data: Registry | null = null

  constructor(repoDir: string) {
    this.store = new AtomicJsonStore(path.join(repoDir, "registry.json"))
  }

  private load(): Registry {
    if (!this.data) {
      if (this.store.exists()) {
        this.data = RegistrySchema.parse(this.store.read())
      } else {
        this.data = { version: 1, updated_at: new Date().toISOString(), entries: {} }
      }
    }
    return this.data
  }

  private save(): void {
    const data = this.load()
    data.updated_at = new Date().toISOString()
    this.store.write(data)
  }

  add(entry: RegistryEntry): void {
    const data = this.load()
    const key = registryKey(entry.type, entry.name)
    data.entries[key] = entry
    this.save()
  }

  remove(name: string, type: ResourceType): boolean {
    const data = this.load()
    const key = registryKey(type, name)
    if (!(key in data.entries)) return false
    delete data.entries[key]
    this.save()
    return true
  }

  lookup(name: string, type?: ResourceType): RegistryEntry | undefined {
    const data = this.load()
    if (type) {
      const key = registryKey(type, name)
      return data.entries[key]
    }
    // Search across all types
    return Object.values(data.entries).find(e => e.name === name)
  }

  list(type?: ResourceType): RegistryEntry[] {
    const data = this.load()
    const all = Object.values(data.entries)
    if (!type) return all
    return all.filter(e => e.type === type)
  }

  search(query: string, opts?: { type?: ResourceType; tag?: string }): RegistryEntry[] {
    const data = this.load()
    const q = query.toLowerCase()
    let results = Object.values(data.entries)

    if (opts?.type) results = results.filter(e => e.type === opts.type)
    if (opts?.tag) results = results.filter(e => e.tags.includes(opts.tag!))

    return results
      .filter(e =>
        e.name.toLowerCase() === q ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q))
      )
      .sort((a, b) => {
        const aExact = a.name.toLowerCase() === q ? 0 : 1
        const bExact = b.name.toLowerCase() === q ? 0 : 1
        if (aExact !== bExact) return aExact - bExact
        const aContains = a.name.toLowerCase().includes(q) ? 0 : 1
        const bContains = b.name.toLowerCase().includes(q) ? 0 : 1
        return aContains - bContains
      })
  }

  getEntries(): RegistryEntry[] {
    return Object.values(this.load().entries)
  }
}
