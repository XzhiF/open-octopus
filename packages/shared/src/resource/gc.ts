import fs from "fs"
import path from "path"
import type { RegistryStore } from "./registry"
import { formatBytes } from "./utils"

export interface GcResult {
  removed: string[]
  freedBytes: number
  freedHuman: string
}

export class GarbageCollector {
  collect(registry: RegistryStore, cacheDir: string): { items: string[]; freedBytes: number } {
    if (!fs.existsSync(cacheDir)) return { items: [], freedBytes: 0 }

    const registeredPaths = new Set<string>()
    const entries = registry.list({ installed: true })
    for (const entry of entries) {
      if (entry.installPath) {
        registeredPaths.add(path.basename(entry.installPath))
      }
    }

    const items: string[] = []
    let freedBytes = 0

    try {
      const dirs = fs.readdirSync(cacheDir)
      for (const dir of dirs) {
        if (!registeredPaths.has(dir)) {
          const fullPath = path.join(cacheDir, dir)
          if (fs.statSync(fullPath).isDirectory()) {
            const size = this.dirSize(fullPath)
            items.push(dir)
            freedBytes += size
          }
        }
      }
    } catch {
      // Cache dir read error — return what we have
    }

    return { items, freedBytes }
  }

  clean(items: string[], cacheDir: string): void {
    for (const item of items) {
      const fullPath = path.join(cacheDir, item)
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true })
      }
    }
  }

  private dirSize(dirPath: string): number {
    let size = 0
    try {
      const files = fs.readdirSync(dirPath, { recursive: true }) as string[]
      for (const file of files) {
        const full = path.join(dirPath, String(file))
        try {
          const stat = fs.statSync(full)
          if (stat.isFile()) size += stat.size
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return size
  }
}
