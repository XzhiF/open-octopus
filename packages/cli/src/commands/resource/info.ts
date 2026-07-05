/**
 * resource info — 显示资源详细信息
 *
 * 查找并展示 manifest 全部字段 + registry 安装信息
 */
import { Command } from "commander"
import { join } from "path"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function infoCommand(): Command {
  return new Command("info")
    .description("Show detailed information about a resource")
    .argument("<name>", "Resource name")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (name: string, opts: { org?: string; format: string }) => {
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

        const manifest = await kernel.find(name)
        if (!manifest) {
          console.error(fmt.error(`Resource not found: ${name}`, "Use 'octopus resource list' to see registered resources"))
          process.exitCode = 4
          return
        }

        // Also look up registry entry for install timestamp
        const registry = await kernel.getRegistry()
        const entry = Object.values(registry.entries).find(e => e.manifest.name === name)

        if (fmt["mode"] === "json" || opts.format === "json") {
          console.log(JSON.stringify({ manifest, installedAt: entry?.installedAt }, null, 2))
          return
        }

        console.log(fmt.detail({
          name: manifest.name,
          type: manifest.type,
          version: manifest.version,
          source: `${manifest.source.protocol}:${manifest.source.location}`,
          hash: manifest.hash.slice(0, 12) + "...",
          description: manifest.description,
          dependencies: manifest.dependencies.length > 0 ? manifest.dependencies.join(", ") : undefined,
          references: manifest.references.length > 0 ? manifest.references.join(", ") : undefined,
          tags: manifest.tags?.join(", "),
          installedAt: entry?.installedAt,
        }))
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
