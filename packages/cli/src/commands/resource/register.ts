/**
 * resource register — 注册资源到 registry
 *
 * 读取 manifest JSON 文件，校验后写入 registry.json
 */
import { Command } from "commander"
import { readFileSync, existsSync } from "fs"
import { resolve, join } from "path"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
  ResourceManifestSchema,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function registerCommand(): Command {
  return new Command("register")
    .description("Register a resource from a manifest JSON file")
    .argument("<manifest>", "Path to manifest JSON file")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (manifestPath: string, opts: { org?: string; format: string }) => {
      const fmt = new OutputFormatter(opts.format as "rich" | "json" | "quiet")
      try {
        const absPath = resolve(manifestPath)
        if (!existsSync(absPath)) {
          console.error(fmt.error(`Manifest file not found: ${absPath}`))
          process.exitCode = 1
          return
        }

        const raw = JSON.parse(readFileSync(absPath, "utf-8"))
        const manifest = ResourceManifestSchema.parse(raw)

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

        await kernel.register(manifest)
        console.log(fmt.success(`Registered ${manifest.type}:${manifest.name} v${manifest.version}`))
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
