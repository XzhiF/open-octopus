import { Command } from "commander"
import chalk from "chalk"

export const evolutionCmd = new Command("evolution")
  .description("Evolution scope and proposal management")

// ── octopus evolution scope ────────────────────────────────────────

evolutionCmd
  .command("scope")
  .description("Show or update evolution scope directions")
  .option("--org <org>", "Organization name")
  .option("--add <direction>", "Add a scope direction")
  .option("--remove <direction>", "Remove a scope direction")
  .action(async (options: { org?: string; add?: string; remove?: string }) => {
    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    const org = options.org || "default"

    // If --add or --remove, update; otherwise show
    if (options.add || options.remove) {
      console.log(chalk.bold("\n=== Update Evolution Scope ==="))
      try {
        const res = await fetch(`${serverUrl}/api/evolution/scope`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            org,
            add: options.add,
            remove: options.remove,
          }),
        })
        if (!res.ok) throw new Error(`Server returned ${res.status}`)
        const body = await res.json() as any
        const data: { scopes: string[] } = { scopes: body.scopes || body.evolution_scope || [] }
        console.log(chalk.green(`Updated scopes: ${data.scopes.join(", ")}`))
      } catch (err: any) {
        console.error(chalk.red(`Failed: ${err.message}`))
        process.exit(1)
      }
      return
    }

    // Show current scopes
    console.log(chalk.bold("\n=== Evolution Scope ==="))
    try {
      const res = await fetch(`${serverUrl}/api/evolution/scope?org=${org}`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const body = await res.json() as any
      const data: { scopes: string[] } = { scopes: body.scopes || body.evolution_scope || [] }

      if (data.scopes.length === 0) {
        console.log(chalk.yellow("No evolution scope configured."))
        console.log(`Add with: octopus evolution scope --add <direction>`)
        return
      }

      for (const scope of data.scopes) {
        console.log(chalk.cyan(`  - ${scope}`))
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })

// ── octopus evolution propose <org> ────────────────────────────────

evolutionCmd
  .command("propose")
  .description("Generate evolution proposals based on configured scope")
  .argument("<org>", "Organization name")
  .option("--count <n>", "Number of proposals to generate")
  .action(async (org: string, options: { count?: string }) => {
    console.log(chalk.bold(`\n=== Generate Proposals for ${org} ===`))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const body: Record<string, unknown> = { org }
      if (options.count) body.count = parseInt(options.count, 10)

      const res = await fetch(`${serverUrl}/api/evolution/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) {
          const err = await res.json() as { error: string }
          console.error(chalk.red(err.error))
          process.exit(1)
        }
        throw new Error(`Server returned ${res.status}`)
      }

      const data = await res.json() as {
        proposals: Array<{
          id: string
          title: string
          problem: string
          solution: string
          feasibilityScore: number
          verificationMethod: string
        }>
      }

      console.log(chalk.green(`\nGenerated ${data.proposals.length} proposals:\n`))
      for (const p of data.proposals) {
        console.log(chalk.yellow(`  ${p.title}`))
        console.log(`  Problem: ${p.problem}`)
        console.log(`  Solution: ${p.solution}`)
        console.log(`  Feasibility: ${p.feasibilityScore}/100`)
        console.log(`  Verification: ${p.verificationMethod}\n`)
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })
