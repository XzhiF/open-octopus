import { Command } from "commander"
import chalk from "chalk"

export const frontierCmd = new Command("frontier")
  .description("Frontier exploration and trending analysis")

// ── octopus frontier history ───────────────────────────────────────

frontierCmd
  .command("history")
  .description("Show frontier exploration history")
  .option("--org <org>", "Organization name")
  .option("--limit <n>", "Max entries to show", "20")
  .action(async (options: { org?: string; limit: string }) => {
    const limit = parseInt(options.limit, 10)
    console.log(chalk.bold("\n=== Frontier Exploration History ==="))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/frontier/history?limit=${limit}`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as Array<{
        id: string
        topic: string
        itemCount: number
        createdAt: string
      }>

      if (data.length === 0) {
        console.log(chalk.yellow("No frontier exploration history found."))
        return
      }

      for (const entry of data) {
        console.log(chalk.cyan(`\n  ${entry.id}`))
        console.log(`  Topic: ${entry.topic}`)
        console.log(`  Items: ${entry.itemCount}`)
        console.log(`  Date:  ${entry.createdAt}`)
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      console.log(`Make sure the server is running: ${serverUrl}`)
      process.exit(1)
    }
  })

// ── octopus frontier propose <project> ─────────────────────────────

frontierCmd
  .command("propose")
  .description("Run frontier exploration for a project")
  .argument("<project>", "Project name or domain to explore")
  .option("--source <source>", "Scrape source: github, papers, or both", "both")
  .option("--org <org>", "Organization name")
  .action(async (project: string, options: { source: string; org?: string }) => {
    console.log(chalk.bold(`\n=== Frontier Propose: ${project} ===`))
    console.log(`Source: ${options.source}`)

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/frontier/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: [project],
          source: options.source,
          org: options.org,
        }),
      })
      if (!res.ok) {
        if (res.status === 404) {
          const err = await res.json() as { error: string }
          console.error(chalk.red(err.error))
          process.exit(1)
        }
        throw new Error(`Server returned ${res.status}`)
      }

      const data = await res.json() as {
        items: Array<{ name: string; url: string; score: number; summary: string }>
        count: number
      }

      console.log(chalk.green(`\nFound ${data.count} frontier items:\n`))
      for (const item of data.items) {
        console.log(chalk.yellow(`  ${item.name} (score: ${item.score})`))
        console.log(`  ${item.summary}`)
        console.log(`  ${item.url}\n`)
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })
