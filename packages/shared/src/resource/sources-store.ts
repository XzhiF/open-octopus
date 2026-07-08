import path from "path"
import { AtomicJsonStore } from "./atomic-json-store"
import { SourcesFileSchema, type SourceEntry, type SourcesFile } from "./types"

const DEFAULT_SOURCES: SourcesFile = { version: 1, sources: [] }

/**
 * SourcesStore — CRUD for sources.json with mtime-based cache invalidation.
 * Follows the same pattern as RegistryStore.
 */
export class SourcesStore {
  private store: AtomicJsonStore<SourcesFile>
  private cache: SourcesFile | null = null
  private cacheMtime = 0

  constructor(basePath: string) {
    this.store = new AtomicJsonStore(
      path.join(basePath, "sources.json"),
      SourcesFileSchema,
      DEFAULT_SOURCES,
    )
  }

  private load(): SourcesFile {
    const mtime = this.store.getMtime()
    if (this.cache && mtime === this.cacheMtime) {
      return this.cache
    }
    this.cache = this.store.read()
    this.cacheMtime = mtime
    return this.cache
  }

  private save(data: SourcesFile): void {
    this.store.write(data)
    this.cache = data
    this.cacheMtime = this.store.getMtime()
  }

  list(): SourceEntry[] {
    return this.load().sources
  }

  get(name: string): SourceEntry | undefined {
    return this.load().sources.find((s) => s.name === name)
  }

  upsert(entry: SourceEntry): void {
    const data = this.load()
    const idx = data.sources.findIndex((s) => s.name === entry.name)
    if (idx >= 0) {
      data.sources[idx] = entry
    } else {
      data.sources.push(entry)
    }
    this.save(data)
  }

  remove(name: string): boolean {
    const data = this.load()
    const idx = data.sources.findIndex((s) => s.name === name)
    if (idx < 0) return false
    data.sources.splice(idx, 1)
    this.save(data)
    return true
  }

  count(): number {
    return this.load().sources.length
  }
}
