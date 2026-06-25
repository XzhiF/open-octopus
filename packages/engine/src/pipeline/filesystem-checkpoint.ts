import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "fs"
import { join, resolve } from "path"
import { randomUUID } from "crypto"
import type { ICheckpointStore, Checkpoint, CheckpointStoreConfig } from "./checkpoint-types"

/**
 * Filesystem-based checkpoint persistence.
 * Stores one JSON file per checkpoint in a directory structure:
 *   {baseDir}/{executionId}/{timestamp}-{uuid}.json
 *   {baseDir}/{executionId}/latest.json (symlink-like pointer to latest)
 */
/**
 * Filesystem-based checkpoint persistence.
 * Stores one JSON file per checkpoint in a directory structure:
 *   {baseDir}/{executionId}/{timestamp}-{uuid}.json
 *   {baseDir}/{executionId}/latest.json (symlink-like pointer to latest)
 */
export class FilesystemCheckpointStore implements ICheckpointStore {
  private baseDir: string

  constructor(
    baseDir: string,
    private config: CheckpointStoreConfig,
  ) {
    this.baseDir = resolve(baseDir)
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
  }

  save(checkpoint: Checkpoint): void {
    let data = JSON.stringify(checkpoint)
    let dataSize = Buffer.byteLength(data, "utf8")

    // Size control: strip outputs if exceeding max_size_bytes
    if (this.config.max_size_bytes > 0 && dataSize > this.config.max_size_bytes) {
      const stripped: Checkpoint = {
        ...checkpoint,
        completedNodes: Object.fromEntries(
          Object.entries(checkpoint.completedNodes).map(([id, node]) => [
            id,
            { ...node, outputs: undefined },
          ]),
        ),
      }
      data = JSON.stringify(stripped)
      dataSize = Buffer.byteLength(data, "utf8")
    }

    const execDir = join(this.baseDir, checkpoint.executionId)

    // Ensure directory exists (with retry for race conditions)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (existsSync(execDir)) break
      try {
        mkdirSync(execDir, { recursive: true })
        // Verify directory was created
        if (existsSync(execDir)) break
      } catch {
        // Directory may have been created by another process
        if (existsSync(execDir)) break
      }
    }

    // Sanitize timestamp for Windows compatibility (replace colons with hyphens)
    const safeTimestamp = checkpoint.timestamp.replace(/:/g, "-")
    const filename = `${safeTimestamp}-${randomUUID()}.json`
    const filePath = join(execDir, filename)
    writeFileSync(filePath, data, "utf8")

    // Write latest pointer (contains just the filename)
    writeFileSync(join(execDir, "latest.json"), JSON.stringify({ file: filename, size: dataSize }), "utf8")

    this.pruneExcess(checkpoint.executionId)
    this.cleanExpired()
  }

  load(executionId: string): Checkpoint | null {
    const execDir = join(this.baseDir, executionId)
    if (!existsSync(execDir)) return null

    // Try latest pointer first
    const latestPath = join(execDir, "latest.json")
    if (existsSync(latestPath)) {
      try {
        const latest = JSON.parse(readFileSync(latestPath, "utf8")) as { file: string }
        const filePath = join(execDir, latest.file)
        if (existsSync(filePath)) {
          return JSON.parse(readFileSync(filePath, "utf8")) as Checkpoint
        }
      } catch {
        // Fallback to directory scan
      }
    }

    // Fallback: find latest by filename
    const files = this.listCheckpointFiles(execDir)
    if (files.length === 0) return null
    const latestFile = files[files.length - 1]
    return JSON.parse(readFileSync(join(execDir, latestFile), "utf8")) as Checkpoint
  }

  cleanExpired(): void {
    if (this.config.ttl <= 0) return

    if (!existsSync(this.baseDir)) return

    const execDirs = readdirSync(this.baseDir)
    const cutoff = new Date(Date.now() - this.config.ttl * 1000)

    for (const dir of execDirs) {
      const execDir = join(this.baseDir, dir)
      try {
        const stat = statSync(execDir)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      const files = this.listCheckpointFiles(execDir)
      let hasFiles = false

      for (const file of files) {
        const filePath = join(execDir, file)
        try {
          const stat = statSync(filePath)
          if (new Date(stat.mtime) < cutoff) {
            rmSync(filePath)
          } else {
            hasFiles = true
          }
        } catch {
          // File may have been deleted by another process
        }
      }

      // Only remove directory if it's truly empty
      try {
        const remaining = readdirSync(execDir)
        if (remaining.length === 0) {
          rmSync(execDir, { recursive: true })
        }
      } catch {
        // Directory may have been deleted by another process
      }
    }
  }

  private pruneExcess(executionId: string): void {
    const execDir = join(this.baseDir, executionId)
    const files = this.listCheckpointFiles(execDir)

    // Keep only the most recent max_checkpoints files
    const toDelete = files.slice(0, Math.max(0, files.length - this.config.max_checkpoints))
    for (const file of toDelete) {
      try { rmSync(join(execDir, file)) } catch {}
    }
  }

  private listCheckpointFiles(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith(".json") && f !== "latest.json")
      .sort()
  }
}

// Legacy aliases for backward compatibility
export { FilesystemCheckpointStore as CheckpointStore }
export { FilesystemCheckpointStore as SqliteCheckpointStore }
