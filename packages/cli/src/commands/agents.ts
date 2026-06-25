import { Command } from "commander"
import { RoleRegistry } from "@octopus/engine"
import { existsSync } from "fs"
import { join } from "path"

export const agentsCmd = new Command("agents")
  .description("角色管理 -- 列出、搜索可用专家角色")

// List command
agentsCmd
  .command("list")
  .description("列出所有可用角色")
  .option("--org <org>", "指定组织")
  .option("--format <format>", "输出格式: table|json", "table")
  .action(async (options: { org?: string; format?: string }) => {
    const registry = createRegistry(options.org)
    await registry.loadIndex()
    const roles = registry.list()

    if (roles.length === 0) {
      console.log("No roles found. Install agency-agents-zh: octopus setup")
      process.exit(1)
    }

    if (options.format === "json") {
      const groups: Record<string, Array<{ name: string; description: string; source: string }>> = {}
      for (const role of roles) {
        const cat = role.category || "uncategorized"
        if (!groups[cat]) groups[cat] = []
        groups[cat].push({ name: role.name, description: role.description, source: role.source })
      }
      console.log(JSON.stringify({ total: roles.length, groups }, null, 2))
    } else {
      // Table format
      const grouped = registry.listByCategory()
      console.log(`\nAvailable roles (${roles.length} total)\n`)
      for (const [category, categoryRoles] of Object.entries(grouped)) {
        console.log(`${category} (${categoryRoles.length})`)
        for (const role of categoryRoles.slice(0, 10)) {
          const src = role.source === "custom" ? " [custom]" : ""
          console.log(`  ${role.name.padEnd(30)} ${role.description}${src}`)
        }
        if (categoryRoles.length > 10) {
          console.log(`  ... and ${categoryRoles.length - 10} more`)
        }
        console.log()
      }
    }
  })

// Search command
agentsCmd
  .command("search")
  .description("搜索角色")
  .argument("<query>", "搜索关键词（支持中文）")
  .option("--org <org>", "指定组织")
  .option("--format <format>", "输出格式: table|json", "table")
  .action(async (query: string, options: { org?: string; format?: string }) => {
    const registry = createRegistry(options.org)
    await registry.loadIndex()
    const results = registry.search(query)

    if (results.length === 0) {
      console.log(`No roles matching "${query}"`)
      process.exit(1)
    }

    if (options.format === "json") {
      console.log(JSON.stringify({
        query,
        total: results.length,
        results: results.map(r => ({
          name: r.name,
          description: r.description,
          category: r.category,
          source: r.source,
        })),
      }, null, 2))
    } else {
      console.log(`\nSearch: "${query}" (${results.length} matches)\n`)
      for (const role of results) {
        console.log(`  ${role.name.padEnd(30)} ${role.description} [${role.category}]`)
      }
    }
  })

function createRegistry(org?: string): RoleRegistry {
  const paths: string[] = []

  // Custom agents in current project
  const cwd = process.cwd()
  const customPath = join(cwd, ".claude/agents")
  if (existsSync(customPath)) paths.push(customPath)

  // Org-level agents
  const homeDir = process.env.HOME || ""
  if (org) {
    const orgPath = join(homeDir, ".octopus", "orgs", org, "agents")
    if (existsSync(orgPath)) paths.push(orgPath)
  }

  // agency-agents-zh
  const agencyPath = join(cwd, "dependencies/agency-agents-zh")
  if (existsSync(agencyPath)) paths.push(agencyPath)

  return new RoleRegistry(paths)
}
