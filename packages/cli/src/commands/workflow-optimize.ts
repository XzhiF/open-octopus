import { Command } from "commander"
import chalk from "chalk"

export const workflowOptimizeCmd = new Command("optimize")
  .description("Workflow optimization analysis and management")

// ── octopus workflow optimize --report ─────────────────────────────

workflowOptimizeCmd
  .command("report")
  .description("Analyze workflows and generate optimization report")
  .option("--days <days>", "Look-back window in days", "30")
  .option("--top <n>", "Number of top inefficient workflows", "10")
  .option("--org <org>", "Organization name")
  .action(async (options: { days: string; top: string; org?: string }) => {
    const days = parseInt(options.days, 10)
    const topN = parseInt(options.top, 10)

    console.log(chalk.bold("\n=== Workflow Optimization Report ==="))
    console.log(`Analysis window: ${days} days`)
    console.log(`Top N: ${topN}\n`)

    // Connect to server API
    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/analysis/workflow-inefficient?days=${days}&topN=${topN}`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as {
        items: Array<{
          workflowId: string
          avgDurationMs: number
          failureRate: number
          totalRuns: number
          suggestions: string[]
        }>
        count: number
      }

      if (!data.items || data.items.length === 0) {
        console.log(chalk.green("No inefficient workflows detected."))
        return
      }

      for (const wf of data.items) {
        console.log(chalk.yellow(`\n--- ${wf.workflowId} ---`))
        console.log(`  Avg duration: ${(wf.avgDurationMs / 1000).toFixed(1)}s`)
        console.log(`  Failure rate: ${(wf.failureRate * 100).toFixed(1)}%`)
        console.log(`  Total runs:   ${wf.totalRuns}`)
        console.log(`  Suggestions:`)
        for (const s of wf.suggestions) {
          console.log(`    - ${s}`)
        }
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed to fetch analysis: ${err.message}`))
      console.log(`Make sure the server is running: ${serverUrl}`)
      process.exit(1)
    }
  })

// ── octopus workflow apply-optimization <id> ───────────────────────

workflowOptimizeCmd
  .command("apply-optimization")
  .description("Apply optimization changes for a specific workflow")
  .argument("<id>", "Workflow ID to optimize")
  .option("--org <org>", "Organization name")
  .option("--base-branch <branch>", "PR target branch", "main")
  .action(async (id: string, options: { org?: string; baseBranch: string }) => {
    console.log(chalk.bold(`\n=== Apply Optimization: ${id} ===`))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/analysis/workflow-apply`, {
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
        console.log(chalk.yellow(data.message || "No changes to apply."))
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })

// ── octopus workflow ab-test <id> ──────────────────────────────────

workflowOptimizeCmd
  .command("ab-test")
  .description("Set up A/B test for a workflow optimization")
  .argument("<id>", "Workflow ID to A/B test")
  .option("--org <org>", "Organization name")
  .option("--split <ratio>", "Traffic split ratio (0-1, default 0.5)", "0.5")
  .action(async (id: string, options: { org?: string; split: string }) => {
    const split = parseFloat(options.split)
    console.log(chalk.bold(`\n=== A/B Test Setup: ${id} ===`))
    console.log(`Traffic split: ${(split * 100).toFixed(0)}% new / ${((1 - split) * 100).toFixed(0)}% original`)

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/analysis/workflow-ab-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: id,
          org: options.org,
          split,
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

      const data = await res.json() as { message: string }
      console.log(chalk.green(data.message || "A/B test configured."))
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })
