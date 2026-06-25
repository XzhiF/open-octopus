import { Command } from "commander"
import chalk from "chalk"
import { searchSkills } from "@octopus/shared"
import { resolveSkillDir, resolveCurrentOrg } from "../utils/path"

export const skillSearchCmd = new Command("skill-search")
  .description("搜索已有 Skill")
  .argument("<query>", "搜索关键词")
  .option("--category <cat>", "按类别过滤")
  .option("--org <org>", "组织名")
  .option("--limit <n>", "返回数量上限", "5")
  .action(async (query: string, opts) => {
    const org = opts.org ?? resolveCurrentOrg()
    const skillsDir = resolveSkillDir(org, "")

    const results = await searchSkills(skillsDir, query, opts.category, parseInt(opts.limit))

    if (results.length === 0) {
      console.log(chalk.yellow(`No skills found matching "${query}"`))
      return
    }

    console.log(chalk.bold(`Found ${results.length} skills:`))
    for (const r of results) {
      console.log(`  ${chalk.green(r.name)} [${r.category}] — ${r.similarity}% match`)
      console.log(chalk.dim(`    ${r.description}`))
    }
  })