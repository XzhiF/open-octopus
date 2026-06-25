import { Command } from "commander"
import chalk from "chalk"

function getServerUrl(): string {
  return process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
}

export const workspaceCmd = new Command("workspace")
  .description("Workspace management commands")

workspaceCmd.command("list")
  .description("List all workspaces")
  .option("--org <org>", "Filter by org")
  .action(async (options) => {
    const org = options.org ?? process.env.OCTOPUS_ORG ?? "default"
    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces?org=${encodeURIComponent(org)}`)
      const data = await res.json() as any[]
      if (!Array.isArray(data) || data.length === 0) {
        console.log(chalk.yellow("No workspaces found"))
        return
      }
      for (const ws of data) {
        console.log(`${ws.id}  ${chalk.green(ws.name)}  [${ws.org}]  ${ws.status}`)
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`))
    }
  })

workspaceCmd.command("create <name>")
  .description("Create a new workspace")
  .option("--org <org>", "Org name")
  .option("--description <desc>", "Description")
  .action(async (name, options) => {
    const org = options.org ?? process.env.OCTOPUS_ORG ?? "default"
    const body = {
      name,
      org,
      description: options.description,
      path: `~/.octopus/orgs/${org}/workspaces/${name}`,
    }
    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        console.log(chalk.green(`Workspace ${data.id} created successfully`))
      } else {
        console.error(chalk.red(`Error: ${data.error}`))
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`))
    }
  })

workspaceCmd.command("get <id>")
  .description("Get workspace details")
  .action(async (id) => {
    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces/${id}`)
      const data = await res.json()
      if (res.ok) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.error(chalk.red(`Error: ${data.error}`))
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`))
    }
  })

workspaceCmd.command("delete <id>")
  .description("Delete a workspace")
  .action(async (id) => {
    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces/${id}`, { method: "DELETE" })
      const data = await res.json()
      if (res.ok) console.log(chalk.green("Deleted"))
      else console.error(chalk.red(`Error: ${data.error}`))
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`))
    }
  })

workspaceCmd.command("tree <id>")
  .description("Show execution tree for a workspace")
  .action(async (id) => {
    try {
      const res = await fetch(`${getServerUrl()}/api/workspaces/${id}/executions`)
      const data = await res.json() as any[]
      if (!Array.isArray(data)) return

      const roots = data.filter((e: any) => !e.parent_id)

      function statusIcon(status: string): string {
        switch (status) {
          case "completed": return chalk.green("✓")
          case "failed": return chalk.red("✗")
          case "running": return chalk.blue("▶")
          case "paused": return chalk.yellow("⏸")
          case "pending": return chalk.gray("○")
          default: return "?"
        }
      }

      function printTree(all: any[], node: any, indent: string) {
        const icon = statusIcon(node.status)
        console.log(`${indent}${icon} ${node.id.slice(0, 8)}  ${node.workflow_name}  [${node.status}]`)
        const children = all.filter((e: any) => e.parent_id === node.id)
        for (let i = 0; i < children.length; i++) {
          const isLast = i === children.length - 1
          printTree(all, children[i], indent + (isLast ? "  └─ " : "  ├─ "))
        }
      }

      if (roots.length === 0) {
        console.log(chalk.yellow("No executions in tree"))
      }
      for (const root of roots) printTree(data, root, "")
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`))
    }
  })