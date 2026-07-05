/**
 * resource install — 从 source 安装资源
 *
 * 1. 创建安装计划 (plan)
 * 2. 校验 source trust
 * 3. 通过 SourceProvider 获取文件
 * 4. 写入安装目录 + 注册到 registry
 */
import { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "fs"
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
  SecurityContext,
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
        { suggestion: "Supported protocols: builtin, local, npm, git" },
      )
  }
}

export function installCommand(): Command {
  return new Command("install")
    .description("Install a resource from a source provider")
    .argument("<name>", "Resource name")
    .option("--type <type>", "Resource type: skill, agent, workflow, source", "skill")
    .option("--version <version>", "Resource version", "latest")
    .option("--source <source>", "Source protocol:location", "builtin:core-pack")
    .option("--trust", "Auto-trust the source")
    .option("--dry-run", "Show install plan without executing")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (
      name: string,
      opts: {
        type: string; version: string; source: string; trust?: boolean
        dryRun?: boolean; org?: string; format: string
      },
    ) => {
      const fmt = new OutputFormatter(opts.format as "rich" | "json" | "quiet")
      try {
        const org = opts.org || resolveCurrentOrg()
        const orgDir = resolveOrgDir(org)
        const resourceDir = join(orgDir, "resources")
        const cacheDir = join(orgDir, "cache", "resources")

        const trustStore = new TrustStore()
        const kernel = new ResourceKernel({
          store: new FsResourceStore(resourceDir),
          trustStore,
          auditLogger: new AuditLogger(join(resourceDir, "audit")),
          cacheDir,
        })

        // Parse source string
        const [protocol, ...locationParts] = opts.source.split(":")
        const location = locationParts.join(":") || opts.source

        // Create install plan
        const plan = await kernel.plan({
          additions: [{ name, type: opts.type, version: opts.version, source: opts.source }],
        })

        if (plan.conflicts.length > 0) {
          console.error(fmt.error(
            `Conflicts detected: ${plan.conflicts.map(c => `${c.name}: ${c.reason}`).join(", ")}`,
          ))
          process.exitCode = 1
          return
        }

        if (opts.dryRun) {
          console.log(fmt.success("Install plan (dry-run):"))
          const rows = plan.additions.map(a => ({
            name: a.name,
            type: a.type,
            version: a.version,
            source: a.source,
          }))
          console.log(fmt.table(rows))
          return
        }

        // Trust check
        const sourceRef = { protocol, location }
        if (opts.trust) {
          trustStore.trust(sourceRef)
        }
        trustStore.assertAllowed(sourceRef)

        // Fetch from provider
        const provider = getProvider(protocol)
        const fetchRef: SourceRef = {
          protocol,
          location,
          version: opts.version,
        }
        const result = await provider.fetch(fetchRef)

        // Determine install target
        const typeDirs: Record<string, string> = {
          skill: "skills", agent: "agents", workflow: "workflows", source: "sources",
        }
        const targetDir = join(orgDir, typeDirs[opts.type] ?? opts.type + "s", name)
        SecurityContext.assertSafePath(targetDir, orgDir)
        mkdirSync(targetDir, { recursive: true })

        // Write files
        for (const file of result.files) {
          const filePath = join(targetDir, file.path)
          SecurityContext.assertSafePath(filePath, orgDir)
          mkdirSync(join(filePath, ".."), { recursive: true })
          writeFileSync(filePath, file.content)
        }

        // Register in kernel
        const manifest = ResourceManifestSchema.parse({
          name,
          type: opts.type,
          version: result.version || opts.version,
          source: { protocol, location, version: result.version || opts.version },
          hash: result.hash,
          dependencies: [],
          references: [],
        })
        await kernel.register(manifest)

        console.log(fmt.success(`Installed ${opts.type}:${name} v${result.version || opts.version}`))
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
