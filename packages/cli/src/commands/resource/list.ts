/**
 * resource list — 列出已注册资源
 *
 * 支持按 type / source 过滤，三种输出模式
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

export function listCommand(): Command {
  return new Command("list")
    .description("List registered resources")
    .option("--type <type>", "Filter by resource type: skill, agent, workflow, source")
    .option("--source <source>", "Filter by source protocol: npm, git, local, builtin")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: { type?: string; source?: string; org?: string; format: string }) => {
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

        const manifests = await kernel.list({
          type: opts.type,
          source: opts.source,
        })

        if (manifests.length === 0) {
          console.log(fmt.error("No resources found", "Use 'octopus resource install' to add resources"))
          return
        }

        const rows = manifests.map(m => ({
          name: m.name,
          type: m.type,
          version: m.version,
          source: `${m.source.protocol}:${m.source.location}`,
          deps: m.dependencies.length > 0 ? m.dependencies.join(", ") : "-",
        }))

        console.log(fmt.table(rows))
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
