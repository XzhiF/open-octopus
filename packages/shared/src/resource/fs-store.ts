import { readFile, writeFile, rename, unlink, stat, open } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ResourceError, ResourceErrorCode } from './errors'

export class AtomicJsonStore {
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  async read(filename: string): Promise<any | null> {
    const mainPath = join(this.dir, filename)
    const bakPath = mainPath + '.bak'

    // Try main file first
    try {
      const content = await readFile(mainPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      // Main file missing or corrupted, try .bak
    }

    try {
      const content = readFileSync(bakPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return null
    }
  }

  async write(filename: string, data: any): Promise<void> {
    const mainPath = join(this.dir, filename)
    const tmpPath = mainPath + '.tmp'
    const bakPath = mainPath + '.bak'

    // Write to temp file first (crash-safe)
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')

    // Move current main to .bak (if exists)
    if (existsSync(mainPath)) {
      await rename(mainPath, bakPath).catch(() => {})
    }

    // Atomically move tmp to main
    await rename(tmpPath, mainPath)
  }
}

export type ReleaseLock = () => Promise<void>

export class FsResourceStore {
  private store: AtomicJsonStore
  private _locked = false

  constructor(private baseDir: string, private concurrent = false) {
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
    this.store = new AtomicJsonStore(baseDir)
  }

  async acquireLock(): Promise<ReleaseLock> {
    if (!this.concurrent) {
      // CLI mode: simple boolean guard
      if (this._locked) {
        throw new ResourceError(ResourceErrorCode.LOCK_HELD, 'Operation in progress')
      }
      this._locked = true
      return async () => { this._locked = false }
    }

    // Server mode: O_EXCL file lock + stale detection (10 min)
    const lockFile = join(this.baseDir, '.lock')
    try {
      const s = await stat(lockFile)
      if (Date.now() - s.mtimeMs > 600_000) {
        // Stale lock, remove
        await unlink(lockFile).catch(() => {})
      }
    } catch {
      // Lock file doesn't exist, good
    }

    for (let i = 0; i <= 5; i++) {
      try {
        const fh = await open(lockFile, 'wx')
        return async () => {
          await fh.close().catch(() => {})
          await unlink(lockFile).catch(() => {})
        }
      } catch {
        if (i === 5) throw new ResourceError(ResourceErrorCode.LOCK_HELD, 'Lock acquire failed after 5 retries')
        await new Promise(r => setTimeout(r, 500))
      }
    }
    // Unreachable, but TypeScript requires return
    return async () => {}
  }

  get atomicStore(): AtomicJsonStore { return this.store }
  get dir(): string { return this.baseDir }
}
