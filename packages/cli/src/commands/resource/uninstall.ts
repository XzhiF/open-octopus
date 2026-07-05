/**
 * resource uninstall — 从 registry 注销并移除资源
 */
import { Command } from "commander"
import { join, resolve as pathResolve } from "path"
import { existsSync, rmSync } from "fs"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function uninstallCommand(): Command {
  return new Command("uninstall")
    .description("Uninstall a registered resource")
    .argument("<name>", "Resource name to uninstall")
    .option("--purge", "Also remove installed files from disk")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (name: string, opts: { purge?: boolean; org?: string; format: string }) => {
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

        // Find resource before unregistering (for purge)
        const manifest = await kernel.find(name)
        if (!manifest) {
          console.error(fmt.error(`Resource not found: ${name}`, "Use 'octopus resource list' to see registered resources"))
          process.exitCode = 4
          return
        }

        await kernel.unregister(name)

        // Purge installed files if requested
        if (opts.purge && manifest) {
          const typeDirs: Record<string, string> = {
            skill: "skills", agent: "agents", workflow: "workflows", source: "sources",
          }
          const installedDir = pathResolve(orgDir, typeDirs[manifest.type] ?? manifest.type + "s", name)
          if (existsSync(installedDir)) {
            rmSync(installedDir, { recursive: true, force: true })
            console.log(fmt.success(`Purged files at ${installedDir}`))
          }
        }

        console.log(fmt.success(`Uninstalled ${name}`))
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
