/**
 * resource sync — 同步工作空间配置与已安装资源
 *
 * 1. 扫描磁盘上已安装的资源
 * 2. 与 registry 对比
 * 3. 报告差异（缺失/多余/版本不匹配）
 * 4. 可选自动修复
 */
import { Command } from "commander"
import { join } from "path"
import { existsSync, readdirSync } from "fs"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
  scanInstalledResources,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function syncCommand(): Command {
  return new Command("sync")
    .description("Sync workspace config with installed resources on disk")
    .option("--fix", "Automatically register missing resources")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: { fix?: boolean; org?: string; format: string }) => {
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

        // Get registered resources
        const registered = await kernel.list()
        const registeredNames = new Set(registered.map(m => m.name))
        const registeredByHash = new Map(registered.map(m => [m.name, m.hash]))

        // F7: Scan installed resources on disk — include .claude/skills/ for project-local installs
        const typeDirs: Record<string, string> = {
          skill: "skills", agent: "agents", workflow: "workflows", source: "sources",
        }
        const onDisk: { name: string; type: string; path: string }[] = []
        for (const [type, dirName] of Object.entries(typeDirs)) {
          const dir = join(orgDir, dirName)
          if (existsSync(dir)) {
            const found = scanInstalledResources(dir)
            for (const r of found) {
              onDisk.push({ name: r.name, type: r.type, path: r.path })
            }
          }
        }
        // F7: Also scan .claude/skills/ (project-local resource install target)
        const claudeSkillsDir = join(orgDir, "..", ".claude", "skills")
        if (existsSync(claudeSkillsDir)) {
          const found = scanInstalledResources(claudeSkillsDir)
          for (const r of found) {
            if (!onDisk.some(o => o.name === r.name)) {
              onDisk.push({ name: r.name, type: r.type, path: r.path })
            }
          }
        }

        const onDiskNames = new Set(onDisk.map(r => r.name))

        // Compute diffs
        const missingFromRegistry = onDisk.filter(r => !registeredNames.has(r.name))
        const missingFromDisk = registered.filter(m => !onDiskNames.has(m.name))

        // F7: Hash mismatch detection — compare registered hash with lock file hash
        const lock = await kernel.getLockFile()
        const hashMismatch: { name: string; registeredHash: string; lockHash: string }[] = []
        for (const lockEntry of lock.resources) {
          const regEntry = registered.find(m => m.name === lockEntry.name)
          if (regEntry && regEntry.hash !== lockEntry.hash) {
            hashMismatch.push({
              name: lockEntry.name,
              registeredHash: regEntry.hash,
              lockHash: lockEntry.hash,
            })
          }
        }

        const rows: Record<string, any>[] = []
        for (const r of missingFromRegistry) {
          rows.push({ name: r.name, type: r.type, status: "on-disk only", action: "register" })
        }
        for (const m of missingFromDisk) {
          rows.push({ name: m.name, type: m.type, status: "registry only", action: opts.fix ? "unregister" : "no files" })
        }
        for (const h of hashMismatch) {
          rows.push({ name: h.name, type: "-", status: "hash mismatch", action: "re-sync" })
        }

        if (rows.length === 0) {
          console.log(fmt.success("Registry and disk are in sync"))
          return
        }

        console.log(fmt.table(rows))

        if (opts.fix && missingFromRegistry.length > 0) {
          console.log("\nRegistering missing resources...")
          for (const r of missingFromRegistry) {
            try {
              // Read manifest from disk if available
              const manifestPath = join(r.path, 'manifest.json')
              if (existsSync(manifestPath)) {
                const { readFileSync } = require('fs')
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
                await kernel.register(manifest)
                console.log(`  ✓ Registered ${r.type}:${r.name}`)
              } else {
                // Create minimal manifest from directory info
                const minimalManifest = {
                  name: r.name,
                  type: r.type,
                  version: '0.0.0',
                  source: { protocol: 'local', location: r.path, version: '0.0.0' },
                  hash: '0'.repeat(64),
                  dependencies: [],
                  references: [],
                }
                await kernel.register(minimalManifest)
                console.log(`  ✓ Registered ${r.type}:${r.name} (minimal manifest)`)
              }
            } catch (err) {
              console.error(`  ✗ Failed to register ${r.name}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }

        // F7: --fix also unregisters "registry only" entries (no files on disk)
        if (opts.fix && missingFromDisk.length > 0) {
          console.log("\nUnregistering stale registry entries...")
          for (const m of missingFromDisk) {
            try {
              await kernel.unregister(m.name)
              console.log(`  ✓ Unregistered ${m.name} (no files on disk)`)
            } catch (err) {
              console.error(`  ✗ Failed to unregister ${m.name}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }

        console.log(`\nSummary: ${missingFromRegistry.length} on-disk only, ${missingFromDisk.length} registry-only, ${hashMismatch.length} hash mismatch`)
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
