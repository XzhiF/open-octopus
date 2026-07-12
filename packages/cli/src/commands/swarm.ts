import { Command } from "commander"
import chalk from "chalk"

export const swarmCmd = new Command("swarm")
  .description("Swarm discussion and coordination")

// ── octopus swarm discuss <topic> ──────────────────────────────────

swarmCmd
  .command("discuss")
  .description("Start a multi-expert discussion on a topic")
  .argument("<topic>", "Discussion topic")
  .option("--experts <roles>", "Comma-separated expert roles (max 5)", "architect,tester,reviewer")
  .option("--sync-chatbot", "Sync final proposal to chatbot")
  .action(async (topic: string, options: { experts: string; syncChatbot?: boolean }) => {
    const experts = options.experts.split(",").map(s => s.trim())

    if (experts.length > 5) {
      console.error(chalk.red("Error: Expert limit is 5"))
      process.exit(1)
    }

    console.log(chalk.bold(`\n=== Swarm Discussion ===`))
    console.log(`Topic: ${topic}`)
    console.log(`Experts: ${experts.join(", ")}\n`)

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/swarm/discuss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          experts,
          syncChatbot: options.syncChatbot ?? false,
        }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as {
        id: string
        expertOpinions: Array<{ expert: string; opinion: string; confidence: number }>
        finalProposal: string
      }

      console.log(chalk.green(`Discussion ID: ${data.id}\n`))

      for (const op of data.expertOpinions) {
        console.log(chalk.cyan(`  [${op.expert}] (confidence: ${op.confidence})`))
        console.log(`  ${op.opinion}\n`)
      }

      console.log(chalk.bold("\n--- Final Proposal ---"))
      console.log(data.finalProposal)
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })

// ── octopus swarm sync-chatbot <id> ────────────────────────────────

swarmCmd
  .command("sync-chatbot")
  .description("Sync a discussion result to the chatbot")
  .argument("<id>", "Discussion ID")
  .action(async (id: string) => {
    console.log(chalk.bold(`\n=== Sync to Chatbot: ${id} ===`))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/swarm/sync-chatbot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discussionId: id }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)

      const data = await res.json() as { success: boolean; syncedAt: string; chatbotUrl?: string }

      if (data.success) {
        console.log(chalk.green(`Synced at: ${data.syncedAt}`))
        if (data.chatbotUrl) console.log(chalk.cyan(`Chatbot URL: ${data.chatbotUrl}`))
      } else {
        console.log(chalk.yellow("Sync failed after retries."))
      }
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })

// ── octopus swarm review <id> ──────────────────────────────────────

swarmCmd
  .command("review")
  .description("Review a discussion result by ID")
  .argument("<id>", "Discussion ID")
  .action(async (id: string) => {
    console.log(chalk.bold(`\n=== Review Discussion: ${id} ===`))

    const serverUrl = process.env.OCTOPUS_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(`${serverUrl}/api/swarm/discussion/${id}`)
      if (!res.ok) {
        if (res.status === 404) {
          console.error(chalk.red(`Discussion not found: ${id}`))
          process.exit(1)
        }
        throw new Error(`Server returned ${res.status}`)
      }

      const data = await res.json() as {
        topic: string
        expertOpinions: Array<{ expert: string; opinion: string; confidence: number }>
        finalProposal: string
      }

      console.log(chalk.cyan(`Topic: ${data.topic}\n`))

      for (const op of data.expertOpinions) {
        console.log(chalk.yellow(`  [${op.expert}] (${op.confidence})`))
        console.log(`  ${op.opinion}\n`)
      }

      console.log(chalk.bold("--- Final Proposal ---"))
      console.log(data.finalProposal)
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`))
      process.exit(1)
    }
  })
