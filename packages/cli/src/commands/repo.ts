/**
 * octopus repo — 资源仓库管理命令组
 *
 * 子命令:
 *   init / register / list / search / info / install /
 *   uninstall / deps / gc / audit / doctor / sync
 */
import { Command } from "commander"
import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import {
  DependencyResolver,
  RepoError,
  formatBytes,
  registryKey,
} from "@octopus/shared"
import type {
  ResourceType,
  SourceRef,
  ResourceManifest,
  InstallPlan as SharedInstallPlan,
  ResourceAuditActionV2 as AuditAction,
} from "@octopus/shared"
import { createRepository } from "../repository"
import { WorkspaceInstaller } from "../repository/installer"
import type { InstallPlan, InstallStep, InstallOptions, InstallResult } from "../repository/installer"
import { ResourceSearcher } from "../repository/searcher"
import { WorkspaceUninstaller } from "../repository/uninstaller"
import { AuditLogger } from "../repository/audit-logger"
import { OutputFormatter } from "../repository/output"
import { scanUnusedCache, runGc, aggregateGcResult } from "../repository/gc"
import { readLockFile, readWorkspaceConfig, computeDrift } from "../repository/lock-manager"

// ── Helpers ─────────────────────────────────────────────────────

function parseSourceRef(ref: string): SourceRef {
  if (ref.startsWith("npm:")) return { protocol: "npm", package: ref.slice(4) }
  if (ref.startsWith("github:")) return { protocol: "github", repo: ref.slice(7) }
  if (ref.startsWith("builtin:")) return { protocol: "builtin", id: ref.slice(8) }
  if (ref.startsWith("./")) return { protocol: "local", path: ref }
  if (ref.startsWith("/")) {
    throw new RepoError(
      `Absolute paths are not allowed: ${ref}`,
      "INVALID_INPUT",
      "Use relative paths (./path) instead of absolute paths",
      2,
    )
  }
  throw new RepoError(
    `Invalid source ref: ${ref}`,
    "MANIFEST_PARSE_ERROR",
    "Use format: npm:<pkg>, github:<owner/repo>, builtin:<id>, or ./path",
    2,
  )
}

function deriveName(source: SourceRef): string {
  switch (source.protocol) {
    case "npm":
      return source.package.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9-]/g, "-")
    case "github":
      return source.repo.split("/").pop() ?? "unknown"
    case "local":
      return source.path.split("/").pop() ?? "unknown"
    case "builtin":
      return source.id
  }
}

function createContext(opts: { repoDir?: string }) {
  return createRepository({ repoDir: opts.repoDir })
}

function handleError(err: any, fmt: OutputFormatter): never {
  if (err instanceof RepoError) {
    console.error(fmt.error(err.code, err.message, err.fix))
    process.exit(err.exitCode)
  }
  console.error(fmt.error("UNKNOWN_ERROR", err.message || String(err), "Check the error details and try again"))
  process.exit(1)
}

/** Convert shared InstallPlan → CLI InstallPlan */
function toInstallPlan(sharedPlan: SharedInstallPlan): InstallPlan {
  return {
    ordered: sharedPlan.ordered.map(step => ({
      name: step.name,
      type: step.type,
      manifest: {
        target: step.manifest.target,
        dependencies: step.manifest.dependencies,
      },
    })),
  }
}

/** Build ResourceManifest[] from manager entries for DependencyResolver */
function buildManifests(manager: ReturnType<typeof createContext>["manager"]): ResourceManifest[] {
  return manager.list().map(e => ({
    name: e.name,
    type: e.type,
    version: e.version,
    description: e.description,
    source: e.source,
    dependencies: e.dependencies,
    tags: e.tags,
  }))
}

// ── Command Group ───────────────────────────────────────────────

export const repoCmd = new Command("repo")
  .description("Octopus 资源仓库管理")

// ── init ────────────────────────────────────────────────────────

repoCmd
  .command("init")
  .description("初始化全局资源仓库")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--force", "强制重新初始化")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager } = createContext(opts)
      manager.initRepo(opts.force)
      console.log(fmt.initSuccess(manager.getRepoDir()))
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── register ────────────────────────────────────────────────────

repoCmd
  .command("register <ref>")
  .description("注册资源到仓库")
  .requiredOption("--type <type>", "资源类型: skill/agent/workflow/source")
  .option("--name <name>", "覆盖资源名称")
  .option("--tag <tags...>", "标签")
  .option("--force", "强制重新注册")
  .option("--trust", "自动信任来源")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (ref: string, opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager, security, audit } = createRepository({ repoDir: opts.repoDir, autoTrust: opts.trust })
      const sourceRef = parseSourceRef(ref)

      await security.checkCallerPermission("register")
      // Always check source trust (blocked sources are always rejected).
      // --trust only enables auto-trust for unknown sources (TOFU skip).
      await security.checkSourceTrust(sourceRef)

      const entry = await manager.register(sourceRef, opts.type as ResourceType, {
        name: opts.name,
        tags: opts.tag,
        force: opts.force,
      })
      audit.log("resource.registered" as AuditAction, {
        name: entry.name, type: entry.type, hash: entry.hash,
        source: ref, detail: { version: entry.version },
      })
      console.log(fmt.registerSuccess(entry))
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── list ────────────────────────────────────────────────────────

repoCmd
  .command("list")
  .description("列出已注册资源")
  .option("--type <type>", "按类型过滤")
  .option("--tag <tag>", "按标签过滤")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager } = createContext(opts)
      const entries = manager.list(opts.type as ResourceType | undefined)
      console.log(fmt.listResources(entries))
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── search ──────────────────────────────────────────────────────

repoCmd
  .command("search <query>")
  .description("搜索仓库资源")
  .option("--type <type>", "按类型过滤")
  .option("--tag <tag>", "按标签过滤")
  .option("--page <n>", "页码", "1")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (query: string, opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager } = createContext(opts)
      const searcher = new ResourceSearcher(manager.getRegistry())
      const result = searcher.search(query, {
        type: opts.type as ResourceType | undefined,
        tag: opts.tag,
        page: parseInt(opts.page),
      })
      console.log(fmt.searchResults(result.results, result.total, result.page, result.per_page))
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── info ────────────────────────────────────────────────────────

repoCmd
  .command("info <name>")
  .description("资源详情")
  .option("--type <type>", "资源类型")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (name: string, opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager } = createContext(opts)
      const entry = manager.lookup(name, opts.type as ResourceType | undefined)
      if (!entry) {
        console.error(fmt.error("RESOURCE_NOT_FOUND", `Resource not found: ${name}`, `octopus repo search ${name}`))
        process.exit(4)
      }
      console.log(fmt.resourceInfo(entry))
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── install ─────────────────────────────────────────────────────

repoCmd
  .command("install <names...>")
  .description("安装资源到工作空间")
  .option("--type <type>", "资源类型")
  .option("--workspace <dir>", "工作空间目录", ".")
  .option("--dry-run", "仅显示安装计划")
  .option("--force", "强制覆盖")
  .option("--yes", "跳过确认（人类专用）")
  .option("--confirmed", "跳过确认（Agent 专用）")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (names: string[], opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const caller = process.env.OCTOPUS_CALLER || "human"

      // SEC-06: Agent cannot use --yes
      if (caller === "agent" && opts.yes) {
        throw new RepoError(
          "Agent cannot use --yes. User confirmation required.",
          "SECURITY_ERROR",
          "Use --confirmed after dialog confirmation",
          5,
        )
      }

      // SEC-06: Agent must provide --confirmed flag
      if (caller === "agent" && !opts.confirmed) {
        throw new RepoError(
          "Agent must use --confirmed flag with OCTOPUS_CALLER=agent.",
          "SECURITY_ERROR",
          "Use --confirmed after dialog confirmation",
          5,
        )
      }

      const { manager, security, audit } = createContext(opts)
      const installer = new WorkspaceInstaller(manager, security)

      // Look up all requested resources
      const entries = names.map((name) => {
        const entry = manager.lookup(name, opts.type as ResourceType | undefined)
        if (!entry) {
          throw new RepoError(`Resource not found: ${name}`, "RESOURCE_NOT_FOUND", `octopus repo search ${name}`, 4)
        }
        return entry
      })

      // Resolve dependencies
      const allEntries = manager.list()
      const manifests = allEntries.map(e => ({
        name: e.name,
        type: e.type,
        version: e.version,
        description: e.description,
        source: e.source,
        dependencies: e.dependencies,
        tags: e.tags,
      }))
      const resolver = new DependencyResolver(manifests)
      const targets = entries.map(e => ({ name: e.name, type: e.type }))
      const plan = resolver.resolve(targets)

      // Show plan
      console.log(fmt.installPlan(plan))

      if (opts.dryRun) return

      // Confirm (interactive only)
      if (!opts.yes && !opts.confirmed) {
        try {
          const inquirer = await import("inquirer")
          const answers = await inquirer.default.prompt([
            { type: "confirm", name: "proceed", message: "Apply changes?", default: true },
          ])
          if (!answers.proceed) {
            console.log("Cancelled.")
            return
          }
        } catch {
          // inquirer not available in non-interp mode, proceed
        }
      }

      // Install
      const installOpts: InstallOptions = {
        workspaceDir: opts.workspace,
        mode: opts.force ? "FORCE" : "FRESH",
        yes: opts.yes,
        confirmed: opts.confirmed,
      }
      const result = await installer.install({ ...plan, skipped: plan.skipped }, installOpts)

      // B-14: Audit log each installed resource
      for (const inst of result.installed) {
        audit.log("resource.installed" as AuditAction, {
          name: inst.name, type: inst.type, hash: inst.hash,
          detail: { target: inst.target },
        })
      }

      // Print progress results
      for (let i = 0; i < result.installed.length; i++) {
        console.log(fmt.installProgress(
          i + 1, plan.ordered.length,
          result.installed[i].name,
          "success",
          `→ ${result.installed[i].target}`,
        ))
      }
      for (const f of result.failed) {
        console.log(fmt.installProgress(
          plan.ordered.length, plan.ordered.length,
          f.name, "failed", f.reason,
        ))
      }

      // Build summary arrays with compatible shapes
      const installedSummary = result.installed.map(i => ({ name: i.name, target: i.target }))
      const failedSummary = result.failed.map(f => ({ name: f.name, reason: f.reason }))

      console.log(fmt.installSummary(installedSummary, failedSummary, result.skipped))
      process.exit(result.status === "success" ? 0 : 1)
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── uninstall ───────────────────────────────────────────────────

repoCmd
  .command("uninstall <name>")
  .description("从工作空间卸载资源")
  .option("--type <type>", "资源类型")
  .option("--workspace <dir>", "工作空间目录", ".")
  .option("--force", "跳过反向依赖检查")
  .option("--confirmed", "跳过确认（Agent 专用）")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (name: string, opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      // SEC-06: Agent gate for uninstall
      const caller = process.env.OCTOPUS_CALLER || "human"
      if (caller === "agent" && !opts.confirmed) {
        throw new RepoError(
          "Agent must use --confirmed flag with OCTOPUS_CALLER=agent.",
          "SECURITY_ERROR",
          "Use --confirmed after dialog confirmation",
          5,
        )
      }

      const { manager, audit } = createContext(opts)
      const entry = manager.lookup(name, opts.type as ResourceType | undefined)
      if (!entry) {
        console.error(fmt.error("RESOURCE_NOT_FOUND", `Resource not found: ${name}`, `octopus repo list`))
        process.exit(4)
      }

      const targetPath = join(`.claude/${entry.type}s`, name)
      const uninstaller = new WorkspaceUninstaller()
      const result = await uninstaller.uninstall(name, entry.type, opts.workspace, targetPath, { force: opts.force })

      audit.log("resource.uninstalled" as AuditAction, {
        name: entry.name, type: entry.type,
        detail: { target: targetPath },
      })

      if (opts.json) {
        console.log(JSON.stringify(result))
      } else {
        console.log(`  ✓ Uninstalled ${entry.type}:${name}`)
        for (const w of result.warnings) {
          console.log(`  ⚠ ${w}`)
        }
      }
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── deps ────────────────────────────────────────────────────────

repoCmd
  .command("deps <name>")
  .description("显示资源依赖树")
  .option("--type <type>", "资源类型")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (name: string, opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager } = createContext(opts)
      const entry = manager.lookup(name, opts.type as ResourceType | undefined)
      if (!entry) {
        console.error(fmt.error("RESOURCE_NOT_FOUND", `Resource not found: ${name}`, `octopus repo search ${name}`))
        process.exit(4)
      }

      if (entry.dependencies.length === 0) {
        console.log(`  ${name} has no dependencies`)
        return
      }

      // Resolve full dependency tree
      const allEntries = manager.list()
      const manifests = allEntries.map(e => ({
        name: e.name,
        type: e.type,
        version: e.version,
        description: e.description,
        source: e.source,
        dependencies: e.dependencies,
        tags: e.tags,
      }))
      const resolver = new DependencyResolver(manifests)
      const resolveResult = resolver.resolve([{ name: entry.name, type: entry.type }])

      if (opts.json) {
        const graph = {
          nodes: resolveResult.ordered.map((s: any) => ({
            id: registryKey(s.type, s.name),
            type: s.type,
          })),
          edges: resolveResult.ordered.flatMap((s: any) =>
            (s.manifest?.dependencies || []).map((d: any) => ({
              from: registryKey(s.type, s.name),
              to: registryKey(d.type, d.name),
              optional: d.optional,
            }))
          ),
        }
        console.log(JSON.stringify({ graph }))
      } else {
        console.log(`  ${entry.type}:${entry.name}`)
        for (const dep of entry.dependencies) {
          const prefix = dep.optional ? " (optional)" : ""
          console.log(`  ├── ${dep.type}:${dep.name}${prefix}`)
        }
        console.log(`\n  ${resolveResult.ordered.length} resources in total.`)
      }
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── gc ──────────────────────────────────────────────────────────

repoCmd
  .command("gc")
  .description("清理无引用缓存")
  .option("--dry-run", "仅显示将清理的内容")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager, security, audit } = createContext(opts)
      await security.checkCallerPermission("gc")

      const repoDir = manager.getRepoDir()
      const entries = manager.list()
      const usedPaths = new Set(entries.map(e => e.cache_path))

      const unused = scanUnusedCache(repoDir, usedPaths)
      const result = aggregateGcResult(unused, entries.length)

      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ would_remove: unused.map(e => e.relPath), freed_bytes: result.freedBytes }))
        } else {
          console.log(`  Would remove ${unused.length} entries (~${formatBytes(result.freedBytes)})`)
          for (const e of unused) console.log(`  - ${e.relPath}`)
        }
        return
      }

      // Actual removal
      runGc(repoDir, unused)

      audit.log("cache.gc" as AuditAction, {
        detail: { removed: unused.length, freed_bytes: result.freedBytes },
      })

      if (opts.json) {
        console.log(JSON.stringify({
          freed_bytes: result.freedBytes,
          removed: unused.length,
          retained: result.retained,
        }))
      } else {
        console.log(`  ✓ Garbage collected: ${unused.length} entries removed (~${formatBytes(result.freedBytes)})`)
      }
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── audit ───────────────────────────────────────────────────────

repoCmd
  .command("audit")
  .description("查询审计日志")
  .option("--last <n>", "最近 N 条", "20")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--workspace <dir>", "工作空间目录", ".")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const repoDir = opts.repoDir ?? join(homedir(), ".octopus", "repository")
      const audit = new AuditLogger(join(repoDir, "audit.jsonl"))
      const entries = audit.readLast(parseInt(opts.last))

      if (opts.json) {
        console.log(JSON.stringify({ entries }))
      } else {
        if (entries.length === 0) {
          console.log(fmt.emptyState("No audit entries", "Perform some operations first"))
          return
        }
        console.log(`  ${"Timestamp".padEnd(26)} ${"Action".padEnd(24)} ${"Caller".padEnd(8)} Resource`)
        console.log(`  ${"─".repeat(24)}  ${"─".repeat(22)}  ${"─".repeat(6)}  ${"─".repeat(20)}`)
        for (const entry of entries) {
          console.log(`  ${(entry.timestamp || "").padEnd(26)} ${(entry.action || "").padEnd(24)} ${(entry.caller || "").padEnd(8)} ${entry.resource_name || ""}`)
        }
      }
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── doctor ──────────────────────────────────────────────────────

repoCmd
  .command("doctor")
  .description("仓库一致性自检")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const { manager } = createContext(opts)
      const repoDir = manager.getRepoDir()
      const entries = manager.list()
      const checks: { name: string; status: string; message: string }[] = []
      const issues: string[] = []

      // Registry integrity
      checks.push({
        name: "registry_integrity",
        status: "pass",
        message: `registry.json valid, ${entries.length} entries`,
      })

      // Cache + manifest consistency
      let cacheOk = 0
      let cacheBad = 0
      for (const entry of entries) {
        const cachePath = join(repoDir, entry.cache_path)
        if (existsSync(cachePath)) {
          cacheOk++
        } else {
          cacheBad++
          issues.push(`Missing cache: ${entry.cache_path} (${entry.type}:${entry.name})`)
        }
      }
      if (cacheBad === 0) {
        checks.push({
          name: "cache_consistency",
          status: "pass",
          message: `All ${cacheOk} cache dirs match registry`,
        })
      } else {
        checks.push({
          name: "cache_consistency",
          status: "warn",
          message: `${cacheBad}/${entries.length} cache dirs missing`,
        })
      }

      // Trust store
      const trustPath = join(repoDir, "trusted-sources.yaml")
      checks.push({
        name: "trust_store",
        status: existsSync(trustPath) ? "pass" : "warn",
        message: existsSync(trustPath) ? "trusted-sources.yaml exists" : "trusted-sources.yaml not found",
      })

      const healthy = checks.every(c => c.status === "pass")
      const passCount = checks.filter(c => c.status === "pass").length
      const warnCount = checks.filter(c => c.status === "warn").length
      const failCount = checks.filter(c => c.status === "fail").length

      if (opts.json) {
        console.log(JSON.stringify({
          checks,
          healthy,
          issues,
          pass_count: passCount,
          warn_count: warnCount,
          fail_count: failCount,
        }))
      } else {
        console.log(`  Octopus Repository Health Check`)
        console.log(`  ${"─".repeat(40)}`)
        for (const check of checks) {
          const icon = check.status === "pass" ? "✅" : check.status === "warn" ? "⚠️" : "❌"
          console.log(`  ${icon} ${check.name.padEnd(24)} ${check.message}`)
        }
        if (issues.length > 0) {
          console.log(`\n  Issues:`)
          for (const issue of issues) {
            console.log(`    · ${issue}`)
          }
        }
        console.log(`\n  ${passCount} passed, ${warnCount} warnings, ${failCount} errors.`)
      }
    } catch (err: any) {
      handleError(err, fmt)
    }
  })

// ── sync ────────────────────────────────────────────────────────

repoCmd
  .command("sync")
  .description("配置漂移检测 (config.json vs resources.lock)")
  .option("--workspace <dir>", "工作空间目录", ".")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const wsDir = opts.workspace

      let config
      try {
        config = readWorkspaceConfig(wsDir)
      } catch {
        console.error(fmt.error("CONFIG_NOT_FOUND", "config.json not found", "Create config.json with 'resources' field"))
        process.exit(2)
      }

      const lock = readLockFile(wsDir)
      const installed = lock.resources ?? []
      const drift = computeDrift(config, installed)

      if (opts.json) {
        console.log(JSON.stringify({
          diff: { add: drift.add, remove: drift.remove, update: drift.update, unchanged: drift.unchanged },
          summary: `${drift.add.length} to add, ${drift.remove.length} to remove, 0 to update, ${drift.unchanged} unchanged`,
        }))
      } else {
        console.log(`  Sync Report:`)
        for (const a of drift.add) console.log(`  + ${a.type}:${a.name.padEnd(30)} ${a.reason}`)
        for (const r of drift.remove) console.log(`  - ${r.type}:${r.name.padEnd(30)} ${r.reason}`)
        console.log(`\n  ${drift.add.length} to add, ${drift.remove.length} to remove, ${drift.unchanged} unchanged.`)
      }
    } catch (err: any) {
      handleError(err, fmt)
    }
  })
