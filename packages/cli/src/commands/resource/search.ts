/**
 * resource search — 搜索可用资源
 *
 * 1. 搜索 registry 中的已注册资源（名称/标签匹配）
 * 2. 扫描本地路径发现已安装但未注册的资源
 */
import { Command } from "commander"
import { join } from "path"
import { existsSync, readdirSync, readFileSync } from "fs"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
  getScanPaths,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function searchCommand(): Command {
  return new Command("search")
    .description("Search for available resources")
    .argument("[query]", "Search query (matches name or description)")
    .option("--type <type>", "Filter by resource type")
    .option("--local", "Scan local paths for installed resources")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (
      query: string | undefined,
      opts: { type?: string; local?: boolean; org?: string; format: string },
    ) => {
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

        // Search registered resources
        const manifests = await kernel.list({ type: opts.type })
        let results = manifests

        // Filter by query
        if (query) {
          const q = query.toLowerCase()
          results = results.filter(m =>
            m.name.toLowerCase().includes(q) ||
            m.description?.toLowerCase().includes(q) ||
            m.tags?.some(t => t.toLowerCase().includes(q)),
          )
        }

        const rows: Record<string, any>[] = results.map(m => ({
          name: m.name,
          type: m.type,
          version: m.version,
          source: `${m.source.protocol}:${m.source.location}`,
          description: m.description ?? "",
        }))

        // Optionally scan local paths for unregistered resources
        if (opts.local) {
          const scanCtx = { cwd: process.cwd(), org, includeResources: true }
          for (const type of ["skill", "agent", "workflow"] as const) {
            if (opts.type && opts.type !== type) continue
            const paths = getScanPaths({ resourceType: type }, scanCtx)
            for (const dir of paths) {
              try {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                  if (entry.isDirectory() && !rows.some(r => r.name === entry.name)) {
                    rows.push({
                      name: entry.name,
                      type,
                      version: "?",
                      source: `local:${dir}`,
                      description: "(unregistered)",
                    })
                  }
                }
              } catch {
                // Ignore scan errors
              }
            }
          }
        }

        if (rows.length === 0) {
          console.log(fmt.error(
            query ? `No resources matching "${query}"` : "No resources found",
            "Try 'octopus resource list' or add --local to scan disk",
          ))
          return
        }

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
