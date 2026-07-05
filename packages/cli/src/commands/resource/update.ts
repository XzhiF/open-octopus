/**
 * resource update — 更新资源到最新版本
 * resource outdated — 检查有哪些资源可以更新
 *
 * update:
 *   1. 列出可更新资源
 *   2. 创建安装计划
 *   3. 重新获取 + 注册
 *
 * outdated:
 *   仅报告版本差异，不执行更新
 */
import { Command } from "commander"
import { join } from "path"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
  ResourceManifestSchema,
  BuiltinSourceProvider,
  LocalSourceProvider,
  NpmSourceProvider,
  GitSourceProvider,
} from "@octopus/shared"
import type { SourceProvider, SourceRef } from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

function getProvider(protocol: string, corePackDir?: string): SourceProvider {
  switch (protocol) {
    case "builtin": return new BuiltinSourceProvider(corePackDir ?? "")
    case "local": return new LocalSourceProvider()
    case "npm": return new NpmSourceProvider()
    case "git": return new GitSourceProvider()
    default:
      throw new ResourceError(
        "INVALID_MANIFEST" as any,
        `Unknown source protocol: ${protocol}`,
      )
  }
}

export function updateCommand(): Command {
  return new Command("update")
    .description("Update resources to their latest versions")
    .argument("[names...]", "Resource names to update (omit for all)")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (names: string[], opts: { org?: string; format: string }) => {
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

        let manifests = await kernel.list()
        if (names.length > 0) {
          manifests = manifests.filter(m => names.includes(m.name))
        }

        if (manifests.length === 0) {
          console.log(fmt.error("No matching resources found", "Use 'octopus resource list' to see registered resources"))
          return
        }

        let updated = 0
        let updateFailures = 0
        for (const manifest of manifests) {
          try {
            const provider = getProvider(manifest.source.protocol)
            const ref: SourceRef = {
              protocol: manifest.source.protocol,
              location: manifest.source.location,
              version: "latest",
            }
            const result = await provider.fetch(ref)

            if (result.version === manifest.version) {
              continue // Already up to date
            }

            // Re-register with new version
            const updatedManifest = ResourceManifestSchema.parse({
              ...manifest,
              version: result.version,
              source: { ...manifest.source, version: result.version },
              hash: result.hash,
            })
            await kernel.register(updatedManifest)
            // F6 fix: emit resource.updated audit entry
            const updateAudit = new AuditLogger(join(resourceDir, "audit"))
            updateAudit.append({
              action: "resource.updated",
              resource: manifest.name,
              caller: "human",
              detail: {
                fromVersion: manifest.version,
                toVersion: result.version,
                oldHash: manifest.hash,
                newHash: result.hash,
              },
            })
            console.log(fmt.success(`Updated ${manifest.name}: ${manifest.version} -> ${result.version}`))
            updated++
          } catch (err: unknown) {
            updateFailures++
            const msg = err instanceof Error ? err.message : String(err)
            console.error(fmt.error(`Failed to update ${manifest.name}: ${msg}`))
          }
        }

        if (updated === 0 && updateFailures === 0) {
          console.log(fmt.success("All resources are up to date"))
        } else if (updated > 0) {
          console.log(fmt.success(`${updated} resource(s) updated`))
        }

        // B-11 fix: Set exit code when updates fail
        if (updateFailures > 0) {
          process.exitCode = 1
        }
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

export function outdatedCommand(): Command {
  return new Command("outdated")
    .description("Check for resources with available updates")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: { org?: string; format: string }) => {
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

        const manifests = await kernel.list()
        if (manifests.length === 0) {
          console.log(fmt.error("No resources registered"))
          return
        }

        const rows: Record<string, any>[] = []
        for (const manifest of manifests) {
          try {
            const provider = getProvider(manifest.source.protocol)
            const ref: SourceRef = {
              protocol: manifest.source.protocol,
              location: manifest.source.location,
              version: "latest",
            }
            // B-12 fix: Add timeout to prevent hanging on slow/unreachable sources
            const TIMEOUT_MS = 30_000
            const result = await Promise.race([
              provider.fetch(ref),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
              ),
            ])

            if (result.version !== manifest.version) {
              rows.push({
                name: manifest.name,
                type: manifest.type,
                current: manifest.version,
                latest: result.version,
                source: `${manifest.source.protocol}:${manifest.source.location}`,
              })
            }
          } catch {
            // Skip resources that can't be checked (timeout, network error, etc.)
          }
        }

        if (rows.length === 0) {
          console.log(fmt.success("All resources are up to date"))
        } else {
          console.log(fmt.table(rows))
          console.log(`\n${rows.length} outdated resource(s). Run 'octopus resource update' to update.`)
        }
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
