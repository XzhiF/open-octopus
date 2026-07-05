/**
 * resource init — 初始化资源目录结构
 *
 * 创建 registry.json + 4 类资源 manifest 目录 + 缓存目录
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
import { resolveOrgDir } from "../../utils/path"
import { resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function initCommand(): Command {
  return new Command("init")
    .description("Initialize resource registry and directories")
    .option("--force", "Force reinitialize even if already initialized")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: { force?: boolean; org?: string; format: string }) => {
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

        await kernel.init({ force: opts.force })
        console.log(fmt.success(`Resource registry initialized at ${resourceDir}`))
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
