/**
 * octopus resources — 声明式资源安装命令
 *
 * 读取 config.json 中的 resources 声明，diff-based 安装到工作空间。
 */
import { Command } from "commander"
import { existsSync, readFileSync } from "fs"
import path from "path"
import {
  WorkspaceConfigSchema,
  DependencyResolver,
  RepoError,
} from "@octopus/shared"
import type { ResourceType, ResourceDependency, ResourceAuditActionV2 as AuditAction } from "@octopus/shared"
import { createRepository } from "../repository"
import { WorkspaceInstaller } from "../repository/installer"
import type { InstallPlan, InstallOptions } from "../repository/installer"
import { OutputFormatter } from "../repository/output"

export const resourcesCmd = new Command("resources")
  .description("工作空间资源管理")

resourcesCmd
  .command("install")
  .description("根据 config.json 声明安装资源（diff-based）")
  .option("--workspace <dir>", "工作空间目录", ".")
  .option("--dry-run", "仅显示安装计划")
  .option("--yes", "跳过确认（人类专用）")
  .option("--confirmed", "跳过确认（Agent 专用）")
  .option("--repo-dir <dir>", "仓库目录")
  .option("--json", "JSON 输出")
  .action(async (opts) => {
    const fmt = new OutputFormatter({ json: opts.json })
    try {
      const caller = process.env.OCTOPUS_CALLER || "human"

      // SEC-06: Agent cannot use --yes
      if (caller === "agent" && opts.yes) {
        throw new RepoError(
          "Agent cannot use --yes",
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

      const wsDir = path.resolve(opts.workspace)
      const configPath = path.join(wsDir, "config.json")

      if (!existsSync(configPath)) {
        console.error(fmt.error("CONFIG_NOT_FOUND", "config.json not found", "Create config.json with 'resources' field"))
        process.exit(2)
      }

      // Parse and validate config
      const raw = JSON.parse(readFileSync(configPath, "utf-8"))
      const config = WorkspaceConfigSchema.parse(raw)
      const resources = config.resources

      if (!resources || (
        resources.skills.length === 0 &&
        resources.agents.length === 0 &&
        resources.workflows.length === 0 &&
        resources.sources.length === 0
      )) {
        console.log(fmt.emptyState(
          "Workspace has no resource declarations",
          'Add "resources" field to config.json',
        ))
        return
      }

      const totalCount = resources.skills.length +
        resources.agents.length +
        resources.workflows.length +
        resources.sources.length

      console.log(`  Reading declarations: config.json → ${totalCount} resources`)

      // Resolve declared resources from repository
      const { manager, security, audit } = createRepository({ repoDir: opts.repoDir, workspaceDir: wsDir })

      audit.log("config.parsed" as AuditAction, {
        detail: { workspace: wsDir, totalCount },
      })

      const installer = new WorkspaceInstaller(manager, security)

      // Build dependency resolver from all registry entries
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
      const targets: { name: string; type: ResourceType }[] = [
        ...resources.skills.map(n => ({ name: n, type: "skill" as const })),
        ...resources.agents.map(n => ({ name: n, type: "agent" as const })),
        ...resources.workflows.map(n => ({ name: n, type: "workflow" as const })),
        ...resources.sources.map(n => ({ name: n, type: "source" as const })),
      ]

      const plan = resolver.resolve(targets)

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
          // inquirer not available, proceed
        }
      }

      // Install
      const installOpts: InstallOptions = {
        workspaceDir: wsDir,
        mode: "FRESH",
        yes: opts.yes,
        confirmed: opts.confirmed,
      }
      const result = await installer.install(plan, installOpts)

      // Print results
      for (let i = 0; i < result.installed.length; i++) {
        const inst = result.installed[i]
        audit.log("resource.installed" as AuditAction, {
          name: inst.name,
          type: inst.type,
          detail: { target: inst.target, source: "resources-install" },
        })
        console.log(fmt.installProgress(
          i + 1, plan.ordered.length,
          inst.name,
          "success",
          `→ ${inst.target}`,
        ))
      }

      const installedSummary = result.installed.map(i => ({ name: i.name, target: i.target }))
      const failedSummary = result.failed.map(f => ({ name: f.name, reason: f.reason }))

      console.log(fmt.installSummary(installedSummary, failedSummary, result.skipped))

      // Audit lock update
      if (result.installed.length > 0) {
        audit.log("lock.updated" as AuditAction, {
          detail: {
            installed: result.installed.length,
            failed: result.failed.length,
            skipped: result.skipped?.length ?? 0,
          },
        })
      }

      process.exit(result.status === "success" ? 0 : 1)
    } catch (err: any) {
      if (err instanceof RepoError) {
        console.error(fmt.error(err.code, err.message, err.fix))
        process.exit(err.exitCode)
      }
      console.error(fmt.error("UNKNOWN_ERROR", err.message || String(err), "Check error details"))
      process.exit(1)
    }
  })
