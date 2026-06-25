import { Command } from "commander"
import { SetupRunner } from "../setup-runner"

export const setupCmd = new Command("setup")
  .description("初始化/更新 ~/.octopus/{org}/ 目录")
  .option("--org <org>", "组织名")
  .option("--dry-run", "仅预览不执行")
  .option("--force", "强制覆盖（忽略名单保护的除外）")
  .action(async (options: { org?: string; dryRun?: boolean; force?: boolean }) => {
    const org = options.org || ""
    const runner = new SetupRunner(
      org,
      options.force ?? false,
      options.dryRun ?? false,
    )
    await runner.run()
  })