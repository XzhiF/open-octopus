import fs from "fs"
import path from "path"

export class ResourceLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResourceLockError"
  }
}

export class AtomicJsonStore<T> {
  private filePath: string
  private tmpPath: string
  private bakPath: string
  private lockPath: string
  private lockTimeoutMs: number

  constructor(filePath: string, lockTimeoutMs = 30_000) {
    this.filePath = filePath
    this.tmpPath = filePath + ".tmp"
    this.bakPath = filePath + ".bak"
    this.lockPath = filePath + ".lock"
    this.lockTimeoutMs = lockTimeoutMs
  }

  read(defaultValue: T): T {
    // Ensure directory exists
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    if (!fs.existsSync(this.filePath)) return defaultValue
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8")
      return JSON.parse(raw) as T
    } catch {
      // Try .bak recovery
      if (fs.existsSync(this.bakPath)) {
        try {
          const raw = fs.readFileSync(this.bakPath, "utf-8")
          return JSON.parse(raw) as T
        } catch {
          return defaultValue
        }
      }
      return defaultValue
    }
  }

  write(data: T): void {
    this.acquireLock()
    try {
      // Backup existing file
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, this.bakPath)
      }
      // Write to temp, then atomic rename
      const json = JSON.stringify(data, null, 2)
      fs.writeFileSync(this.tmpPath, json, "utf-8")
      fs.renameSync(this.tmpPath, this.filePath)
    } finally {
      this.releaseLock()
    }
  }

  recover(): T | null {
    if (!fs.existsSync(this.bakPath)) return null
    try {
      const raw = fs.readFileSync(this.bakPath, "utf-8")
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private acquireLock(): void {
    // ponytail: try-and-recover — no spin-lock (single-threaded Node can't busy-wait its way out)
    if (fs.existsSync(this.lockPath)) {
      try {
        const stat = fs.statSync(this.lockPath)
        const age = Date.now() - stat.mtimeMs
        if (age > this.lockTimeoutMs) {
          // Stale lock — clean up and proceed
          fs.unlinkSync(this.lockPath)
        } else {
          throw new ResourceLockError(`Lock held by another process (age ${Math.round(age / 1000)}s)`)
        }
      } catch (err) {
        if (err instanceof ResourceLockError) throw err
        // stat failed — lock file is broken, remove it
        try { fs.unlinkSync(this.lockPath) } catch { /* ignore */ }
      }
    }
    fs.writeFileSync(this.lockPath, String(Date.now()), "utf-8")
  }

  private releaseLock(): void {
    try { fs.unlinkSync(this.lockPath) } catch { /* ignore */ }
  }
}
