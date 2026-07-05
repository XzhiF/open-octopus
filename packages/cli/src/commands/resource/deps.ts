/**
 * resource deps — 显示资源依赖树
 *
 * 使用 DependencyResolver 构建依赖图，拓扑排序后显示树状结构
 */
import { Command } from "commander"
import { join } from "path"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  DependencyResolver,
  ResourceError,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function depsCommand(): Command {
  return new Command("deps")
    .description("Show dependency tree for resources")
    .argument("[name]", "Resource name (omit to show all)")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (name: string | undefined, opts: { org?: string; format: string }) => {
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
          console.log(fmt.error("No resources registered", "Use 'octopus resource install' to add resources"))
          return
        }

        const resolver = new DependencyResolver()
        for (const m of manifests) {
          resolver.addManifest(m)
        }

        // Determine targets
        const targets = name ? [name] : manifests.map(m => m.name)

        // Resolve install order
        let installOrder: string[]
        try {
          installOrder = resolver.resolve(targets)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(fmt.error(msg, "Fix dependency cycle in resource manifests"))
          process.exitCode = 5
          return
        }

        if (opts.format === "json") {
          const depGraph = manifests.map(m => ({
            name: m.name,
            type: m.type,
            version: m.version,
            dependencies: m.dependencies,
          }))
          console.log(JSON.stringify({ installOrder, graph: depGraph }, null, 2))
          return
        }

        // Build tree display
        const lines: string[] = []
        if (name) {
          // Show tree for specific resource
          const manifest = resolver.getManifest(name)
          if (!manifest) {
            console.error(fmt.error(`Resource not found: ${name}`))
            process.exitCode = 4
            return
          }
          lines.push(`${name} v${manifest.version}`)
          buildTree(resolver, name, lines, "  ", new Set())
        } else {
          // Show all as install order
          lines.push("Install order:")
          for (let i = 0; i < installOrder.length; i++) {
            const m = resolver.getManifest(installOrder[i])
            const deps = m && m.dependencies.length > 0 ? ` (deps: ${m.dependencies.join(", ")})` : ""
            lines.push(`  ${i + 1}. ${installOrder[i]}${deps}`)
          }
        }

        console.log(fmt.tree(lines))
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

function buildTree(
  resolver: DependencyResolver,
  name: string,
  lines: string[],
  prefix: string,
  visited: Set<string>,
): void {
  if (visited.has(name)) {
    lines.push(`${prefix}└── ${name} (circular)`)
    return
  }
  visited.add(name)

  const manifest = resolver.getManifest(name)
  if (!manifest || manifest.dependencies.length === 0) return

  const deps = manifest.dependencies
  for (let i = 0; i < deps.length; i++) {
    const isLast = i === deps.length - 1
    const connector = isLast ? "└── " : "├── "
    const dep = deps[i]
    const depManifest = resolver.getManifest(dep)
    const version = depManifest ? ` v${depManifest.version}` : " (missing)"
    lines.push(`${prefix}${connector}${dep}${version}`)
    buildTree(resolver, dep, lines, prefix + (isLast ? "    " : "│   "), visited)
  }
}
