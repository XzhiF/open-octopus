import { Command } from "commander"
import chalk from "chalk"

export const workflowRetireCmd = new Command("retire")
  .description("Workflow retirement analysis and management")

// ── octopus workflow retire --report ───────────────────────────────

workflowRetireCmd
  .command("report")
  .description("Identify workflows eligible for retirement")
  .option("--days <days>", "Look-back window in days", "90")
  .option("--usage-threshold <n>", "Max usage rate (runs/day)", "0.05")
  .option("--failure-threshold <n>", "Min failure rate", "0.5")
  .option("--org <org>", "Organization name")
  .action(async (options: { days: string; usageThreshold: string; failureThreshold: string; org?: string }) => {
    const days = parseInt(options.days, 10)
    const usageThreshold = parseFloat(options.usageThreshold)
    const failureThreshold = parseFloat(options.failureThreshold)

    console.log(chalk.bold("\n=== Workflow Retirement Report ==="))
    console.log(`Analysis window: ${days} days`)
    console.log(`Usage threshold: < ${usageThreshold} runs/day`)
    console.log(`Failure threshold: > ${(failureThreshold * 100).toFixed(0)}%\n`)

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(
        `${serverUrl}/api/analysis/retire-candidates?days=${days}&usageThreshold=${usageThreshold}&failureThreshold=${failureThreshold}`,
      )
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as Array<{
        workflowId: string
        usageRate: number
        failureRate: number
        lastExecution: string | null
        reason: string[]
        impact: string
      }>

      if (data.length === 0) {
        console.log(chalk.green("No retirement candidates found."))
        return
      }

      for (const c of data) {
        console.log(chalk.yellow(`\n--- ${c.workflowId} ---`))
        console.log(`  Usage rate:    ${c.usageRate.toFixed(3)} runs/day`)
        console.log(`  Failure rate:  ${(c.failureRate * 100).toFixed(1)}%`)
        console.log(`  Impact:        ${c.impact}`)
        console.log(`  Last run:      ${c.lastExecution || "N/A"}`)
        console.log(`  Reasons:`)
        for (const r of c.reason) {
          console.log(`    - ${r}`)
        }
      }

      console.log(chalk.bold(`\nTotal candidates: ${data.length}`))
    } catch (err: any) {
      console.error(chalk.red(`Failed to fetch report: ${err.message}`))
      console.log(`Make sure the server is running: ${serverUrl}`)
      process.exit(1)
    }
  })

// ── octopus workflow retire <id> ───────────────────────────────────

workflowRetireCmd
  .command("archive")
  .description("Archive (retire) a specific workflow")
  .argument("<id>", "Workflow ID to retire")
  .option("--org <org>", "Organization name")
  .option("--base-branch <branch>", "PR target branch", "main")
  .action(async (id: string, options: { org?: string; baseBranch: string }) => {
    console.log(chalk.bold(`\n=== Retire Workflow: ${id} ===`))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/analysis/retire-archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: id,
          org: options.org,
          baseBranch: options.baseBranch,
        }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as { prUrl?: string; message: string }
      if (data.prUrl) {
        console.log(chalk.green(`PR created: ${data.prUrl}`))
      } else {
        console.log(chalk.yellow(data.message || "Workflow archived."))
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })

// ── octopus workflow retire --protected ────────────────────────────

workflowRetireCmd
  .command("protected")
  .description("List protected workflows (exempt from retirement)")
  .option("--org <org>", "Organization name")
  .action(async (options: { org?: string }) => {
    console.log(chalk.bold("\n=== Protected Workflows ==="))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const org = options.org || "default"
      const res = await fetch(`${serverUrl}/api/analysis/retire-protected?org=${org}`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as string[]

      if (data.length === 0) {
        console.log(chalk.yellow("No protected workflows configured."))
        return
      }

      for (const id of data) {
        console.log(`  - ${id}`)
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })
