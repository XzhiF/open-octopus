import { Command } from "commander"
import { Installer } from "../installer"
import { SetupRunner } from "../setup-runner"
import { resolveCurrentOrg } from "../utils/path"
import { resolveOrgDir } from "@octopus/shared"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"

export const initCmd = new Command("init")
  .description("初始化项目目录（安装 Skills + Agents + org 配置）")
  .argument("[dir]", "目标目录", ".")
  .option("--org <org>", "组织名")
  .option("--force", "强制覆盖已存在的配置")
  .action(async (dir: string, options: { org?: string; force?: boolean }) => {
    const targetDir = resolve(dir)
    const org = options.org || resolveCurrentOrg(targetDir)
    const orgDir = resolveOrgDir(org)

    if (!existsSync(orgDir)) {
      console.error(`Org '${org}' not set up. Run: octopus setup --org ${org}`)
      process.exit(1)
    }

    const installer = new Installer(targetDir, org, options.force ?? false)
    installer.run()
    console.log(`✓ Initialized octopus for org '${org}' in ${targetDir}`)

    const wsConfigDir = join(targetDir, ".octopus")
    mkdirSync(wsConfigDir, { recursive: true })
    const wsConfigPath = join(wsConfigDir, "config.yaml")
    const existing = existsSync(wsConfigPath)
      ? readFileSync(wsConfigPath, "utf-8")
      : ""
    if (!existing.includes("org:")) {
      writeFileSync(wsConfigPath, existing + `\norg: ${org}\n`, "utf-8")
    }

    const runner = new SetupRunner(org, options.force ?? false, false)
    await runner.run()
  })