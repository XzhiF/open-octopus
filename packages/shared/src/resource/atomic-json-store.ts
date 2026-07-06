import fs from "fs"
import path from "path"
import { ResourceError } from "./errors"

/**
 * Atomic JSON file store with .bak recovery.
 * Write: temp file → rename (atomic on same filesystem).
 * Read: validate schema, fallback to .bak if corrupt.
 */
export class AtomicJsonStore<T extends { version: number }> {
  private filePath: string
  private bakPath: string
  private schema: { parse: (data: unknown) => T }
  private defaultData: T

  constructor(
    filePath: string,
    schema: { parse: (data: unknown) => T },
    defaultData: T,
  ) {
    this.filePath = filePath
    this.bakPath = filePath + ".bak"
    this.schema = schema
    this.defaultData = defaultData
  }

  /** Read with .bak fallback on corruption */
  read(): T {
    // Try primary — no existsSync check, just read and catch (fixes TOCTOU B6)
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw)
      return this.schema.parse(parsed)
    } catch (primaryErr) {
      // Primary missing or corrupt — try .bak recovery
      try {
        const raw = fs.readFileSync(this.bakPath, "utf-8")
        const parsed = JSON.parse(raw)
        const recovered = this.schema.parse(parsed)
        console.warn(`[AtomicJsonStore] Primary corrupt, recovered from .bak: ${this.filePath}`)
        return recovered
      } catch (bakErr) {
        // B3 fix: distinguish "no files yet" (return defaults) vs "both corrupt" (throw)
        const primaryMissing = (primaryErr as NodeJS.ErrnoException).code === "ENOENT"
        const bakMissing = (bakErr as NodeJS.ErrnoException).code === "ENOENT"

        if (primaryMissing && bakMissing) {
          // Fresh install — no files yet, return defaults
          return structuredClone(this.defaultData)
        }

        // At least one file exists but is corrupt — data loss risk
        throw new ResourceError(
          "REGISTRY_CORRUPT",
          `Both primary and .bak files corrupt or unreadable. ` +
          `Primary: ${this.filePath}, bak: ${this.bakPath}. ` +
          `Primary error: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}. ` +
          `Bak error: ${bakErr instanceof Error ? bakErr.message : bakErr}`,
        )
      }
    }
  }

  /** Atomic write: write to .tmp then rename */
  write(data: T): void {
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Backup current file
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.bakPath)
    }

    const tmpPath = this.filePath + ".tmp"
    const json = JSON.stringify(data, null, 2) + "\n"
    fs.writeFileSync(tmpPath, json, "utf-8")
    fs.renameSync(tmpPath, this.filePath)
  }

  /** Get file mtime for cache invalidation */
  getMtime(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs
    } catch {
      return 0
    }
  }

  getPath(): string {
    return this.filePath
  }
}
