/**
 * resource gc — 垃圾回收未使用的缓存文件
 *
 * 扫描缓存目录，对比 registry 中的 hash，删除不再引用的缓存
 */
import { Command } from "commander"
import { join } from "path"
import { existsSync, readdirSync, statSync, rmSync } from "fs"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function gcCommand(): Command {
  return new Command("gc")
    .description("Garbage collect unused cached resource files")
    .option("--dry-run", "Show what would be deleted without deleting")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: { dryRun?: boolean; org?: string; format: string }) => {
      const fmt = new OutputFormatter(opts.format as "rich" | "json" | "quiet")
      try {
        const org = opts.org || resolveCurrentOrg()
        const orgDir = resolveOrgDir(org)
        const resourceDir = join(orgDir, "resources")
        const cacheDir = join(orgDir, "cache", "resources")

        const kernel = new ResourceKernel({
          store: new FsResourceStore(resourceDir),
          trustStore: new TrustStore(),
          auditLogger: new AuditLogger(join(resourceDir, "audit")),
          cacheDir,
        })

        if (!existsSync(cacheDir)) {
          console.log(fmt.success("No cache directory found, nothing to clean"))
          return
        }

        // Collect hashes referenced in registry
        const registry = await kernel.getRegistry()
        const referencedHashes = new Set<string>()
        const referencedCachePaths = new Set<string>()
        for (const entry of Object.values(registry.entries)) {
          referencedHashes.add(entry.manifest.hash)
          if (entry.cachePath) referencedCachePaths.add(entry.cachePath)
        }

        // Scan cache directory
        const cacheEntries = readdirSync(cacheDir, { withFileTypes: true })
        const toDelete: { name: string; size: number }[] = []

        for (const entry of cacheEntries) {
          const fullPath = join(cacheDir, entry.name)
          // Skip if this cache path is referenced
          if (referencedCachePaths.has(fullPath)) continue

          // Check if file hash matches any registered resource
          if (entry.isFile()) {
            const nameWithoutExt = entry.name.replace(/\.[^.]+$/, "")
            if (!referencedHashes.has(nameWithoutExt) && !referencedCachePaths.has(entry.name)) {
              const size = statSync(fullPath).size
              toDelete.push({ name: entry.name, size })
            }
          } else if (entry.isDirectory()) {
            // Directory cache entry — check if referenced
            if (!referencedCachePaths.has(fullPath) && !referencedCachePaths.has(entry.name)) {
              let totalSize = 0
              try {
                const dirEntries = readdirSync(fullPath, { recursive: true }) as string[]
                for (const f of dirEntries) {
                  try {
                    const s = statSync(join(fullPath, f))
                    if (s.isFile()) totalSize += s.size
                  } catch { /* ignore */ }
                }
              } catch { /* ignore */ }
              toDelete.push({ name: entry.name + "/", size: totalSize })
            }
          }
        }

        if (toDelete.length === 0) {
          console.log(fmt.success("Cache is clean, nothing to collect"))
          return
        }

        const totalSize = toDelete.reduce((sum, e) => sum + e.size, 0)
        const rows = toDelete.map(e => ({
          name: e.name,
          size: formatBytes(e.size),
        }))

        if (opts.dryRun) {
          console.log(fmt.table(rows))
          console.log(`\nWould delete ${toDelete.length} entries (${formatBytes(totalSize)})`)
          return
        }

        // Delete
        let deleted = 0
        for (const entry of toDelete) {
          const fullPath = join(cacheDir, entry.name.replace(/\/$/, ""))
          try {
            rmSync(fullPath, { recursive: true, force: true })
            deleted++
          } catch {
            console.error(fmt.error(`Failed to delete: ${entry.name}`))
          }
        }

        console.log(fmt.success(`Collected ${deleted}/${toDelete.length} entries (${formatBytes(totalSize)} freed)`))
      } catch (err: unknown) {
        if (err instanceof ResourceError) {
          process.exitCode = ResourceError.toExitCode(err.code as any)
          console.error(fmt.error(err.message, err.suggestion))
        } else {
          process.exitCode = 1
          console.error(fmt.error(err instanceof Error ? err.message : String(err)))
        }
      }
    })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
