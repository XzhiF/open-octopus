import { Command } from "commander"
import { resolveOrgDir, resolveReposConfig } from "@octopus/shared"
import { resolveCurrentOrg } from "../utils/path"
import { ReposManager, ReposError } from "../repos-manager"
import { existsSync } from "fs"
import { join } from "path"

export const reposCmd = new Command("repos")
  .description("管理项目仓库索引")

function splitComma(s?: string): string[] | undefined {
  return s ? s.split(",").map(d => d.trim()).filter(Boolean) : undefined
}

function initManager(options: { org?: string; groups?: string; cloneBase?: string }): ReposManager {
  const org = options.org || resolveCurrentOrg()
  ensureOrgDir(org)
  const config = resolveReposConfig(org, {
    groupsOverride: options.groups,
    cloneBaseOverride: options.cloneBase,
  })
  return new ReposManager(config)
}

reposCmd
  .command("list")
  .description("列出 manifest 中的所有仓库")
  .option("--org <org>", "组织名")
  .option("--groups <groups>", "覆盖 groups（逗号分隔）")
  .option("--clone-base <dir>", "覆盖 clone_base 目录")
  .action(async (options: { org?: string; groups?: string; cloneBase?: string }) => {
    const manager = initManager(options)
    await manager.list()
  })

reposCmd
  .command("update")
  .description("扫描 manifest 并更新 index")
  .option("--org <org>", "组织名")
  .option("--scan-dirs <dirs>", "额外扫描目录（逗号分隔）")
  .option("--clone-missing", "克隆缺失项目")
  .option("--ai-desc <cli>", "AI CLI 名称 (opencode/claude/qoder)")
  .option("--groups <groups>", "覆盖 groups（逗号分隔）")
  .option("--clone-base <dir>", "覆盖 clone_base 目录")
  .action(async (options: { org?: string; scanDirs?: string; cloneMissing?: boolean; aiDesc?: string; groups?: string; cloneBase?: string }) => {
    const manager = initManager(options)
    await manager.update(splitComma(options.scanDirs), options.cloneMissing, options.aiDesc)
  })

reposCmd
  .command("pull")
  .description("拉取指定项目的最新代码")
  .argument("[projects...]", "项目名列表")
  .option("--org <org>", "组织名")
  .option("--branch <branch>", "指定分支")
  .option("--groups <groups>", "覆盖 groups（逗号分隔）")
  .option("--clone-base <dir>", "覆盖 clone_base 目录")
  .action(async (projects: string[], options: { org?: string; branch?: string; groups?: string; cloneBase?: string }) => {
    const manager = initManager(options)
    try {
      await manager.pull(projects.length > 0 ? projects : undefined, options.branch)
    } catch (e: unknown) {
      if (e instanceof ReposError) {
        console.error(e.message)
        process.exit(1)
      }
      console.error(String(e))
    }
  })

reposCmd
  .command("clone")
  .description("克隆指定项目（支持多个）")
  .argument("<projects...>", "项目名列表")
  .option("--org <org>", "组织名")
  .option("--branch <branch>", "指定分支")
  .option("--groups <groups>", "覆盖 groups（逗号分隔）")
  .option("--clone-base <dir>", "覆盖 clone_base 目录")
  .action(async (projects: string[], options: { org?: string; branch?: string; groups?: string; cloneBase?: string }) => {
    const manager = initManager(options)
    try {
      const result = await manager.cloneProjects(projects, options.branch)
      if (result.success.length > 0) {
        console.log("Tip: run 'octopus repos rebuild-index' to update index")
      }
      if (result.failed.length > 0) {
        process.exit(1)
      }
    } catch (e: unknown) {
      if (e instanceof ReposError) {
        console.error(e.message)
        process.exit(1)
      }
      console.error(String(e))
      process.exit(1)
    }
  })

reposCmd
  .command("sync")
  .description("一键同步：克隆缺失 + 拉取所有 + 重建索引")
  .option("--org <org>", "组织名")
  .option("--branch <branch>", "pull 时覆盖分支")
  .option("--no-clone", "跳过 clone-missing 步骤")
  .option("--no-pull", "跳过 pull-all 步骤")
  .option("--no-rebuild", "跳过 rebuild-index 步骤")
  .option("--ai-desc <cli>", "rebuild-index 时使用 AI CLI")
  .option("--scan-dirs <dirs>", "额外扫描目录（逗号分隔）")
  .option("--groups <groups>", "覆盖 groups（逗号分隔）")
  .option("--clone-base <dir>", "覆盖 clone_base 目录")
  .action(async (options: {
    org?: string
    branch?: string
    clone?: boolean
    pull?: boolean
    rebuild?: boolean
    aiDesc?: string
    scanDirs?: string
    groups?: string
    cloneBase?: string
  }) => {
    const manager = initManager(options)
    try {
      const result = await manager.sync({
        clone: options.clone,
        pull: options.pull,
        rebuild: options.rebuild,
        branchOverride: options.branch,
        aiDescCli: options.aiDesc,
        scanDirs: splitComma(options.scanDirs),
      })
      const totalFailed = result.cloned.failed + result.pulled.failed
      if (totalFailed > 0) {
        process.exit(1)
      }
    } catch (e: unknown) {
      if (e instanceof ReposError) {
        console.error(e.message)
        process.exit(1)
      }
      console.error(String(e))
      process.exit(1)
    }
  })

reposCmd
  .command("rebuild-index")
  .description("重建 index.md")
  .option("--org <org>", "组织名")
  .option("--ai-desc <cli>", "AI CLI 名称 (opencode/claude/qoder)")
  .option("--scan-dirs <dirs>", "扫描外部目录（逗号分隔）")
  .option("--groups <groups>", "覆盖 groups（逗号分隔）")
  .option("--clone-base <dir>", "覆盖 clone_base 目录")
  .action(async (options: { org?: string; aiDesc?: string; scanDirs?: string; groups?: string; cloneBase?: string }) => {
    const manager = initManager(options)
    await manager.rebuildIndex(options.aiDesc, splitComma(options.scanDirs))
  })

function ensureOrgDir(org: string): void {
  const orgDir = resolveOrgDir(org)
  const jsonPath = join(orgDir, "repos", "manifest.json")
  const mdPath = join(orgDir, "repos", "manifest.md")

  if (!existsSync(orgDir)) {
    throw new ReposError(`Org directory not found: ${orgDir}. Run: octopus setup --org ${org}`)
  }

  // Accept either manifest.json or manifest.md
  if (!existsSync(jsonPath) && !existsSync(mdPath)) {
    throw new ReposError(`Manifest not found: ${jsonPath}. Run: octopus setup --org ${org}`)
  }
}