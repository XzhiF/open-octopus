import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { createHmac, timingSafeEqual } from "crypto"
import type { ExperienceLifecycleService } from "../services/experience/lifecycle-service"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"

interface WebhookDeps {
  lifecycleService: ExperienceLifecycleService
  githubSecret?: string
  archiveDAO?: ArchiveDAO
  experienceDAO?: ExperienceDAO
  executionDAO?: ExecutionDAO
}

export function createWebhookRoutes(deps: WebhookDeps) {
  const router = new Hono()

  // POST /webhooks/github
  router.post("/github", async (c) => {
    const signature = c.req.header("x-hub-signature-256")
    const event = c.req.header("x-github-event")

    if (!deps.githubSecret) {
      console.warn("[webhooks] GITHUB_WEBHOOK_SECRET not configured")
      return c.json({ error: "Webhook not configured" }, 500)
    }

    if (!signature || !event) {
      return c.json({ error: "Missing signature or event header" }, 400)
    }

    const body = await c.req.text()

    if (!verifySignature(body, signature, deps.githubSecret)) {
      return c.json({ error: "Invalid signature" }, 401)
    }

    if (event !== "pull_request") {
      return c.json({ ok: true, ignored: true })
    }

    try {
      const payload = JSON.parse(body)
      const action = payload.action
      const pr = payload.pull_request

      if (action !== "closed" || !pr?.merged) {
        return c.json({ ok: true, ignored: true })
      }

      const prUrl = pr.html_url
      const prBody = pr.body ?? ""

      const resolvedCount = await deps.lifecycleService.markResolved(prUrl, prBody)

      return c.json({ resolved_count: resolvedCount })
    } catch (err) {
      console.error("[webhooks] GitHub webhook processing failed:", err)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  return router
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
  // ponytail: constant-time comparison via timingSafeEqual; length mismatch falls back to false
  if (signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

/**
 * createTelegramWebhookRoute — standalone Telegram webhook mounted at /api/agent/telegram
 * so the full endpoint path becomes /api/agent/telegram/webhook.
 */
export function createTelegramWebhookRoute(deps: {
  archiveDAO?: ArchiveDAO
  experienceDAO?: ExperienceDAO
  executionDAO?: ExecutionDAO
  scheduleDAO?: import("../db/dao/schedule-config-dao").ScheduleConfigDAO
  enginePool?: import("../services/execution/EnginePool").EnginePool
  workflowService?: import("../services/workflow").WorkflowService
}) {
  const router = new Hono()

  router.post("/webhook", async (c) => {
    const secretToken = c.req.header("X-Telegram-Bot-Api-Secret-Token")
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET

    if (expectedSecret && secretToken !== expectedSecret) {
      return c.json({ error: "Invalid secret token" }, 401)
    }

    try {
      const body = await c.req.json()
      const message = body.message
      if (!message?.text) {
        return c.json({ ok: true })
      }

      const chatId = message.chat.id
      const text = message.text

      const { TelegramCommandParser } = await import("../services/agent/telegram-command-parser")
      const { TelegramCommandHandler } = await import("../services/agent/telegram-command-handler")

      const command = TelegramCommandParser.parse(text)

      let archiveDAO = deps.archiveDAO
      let experienceDAO = deps.experienceDAO
      let executionDAO = deps.executionDAO

      if (!archiveDAO || !experienceDAO || !executionDAO) {
        const { getDb } = await import("../db/connection")
        const db = getDb()
        const daoModule = await import("../db/dao")
        archiveDAO = archiveDAO ?? new daoModule.ArchiveDAO(db)
        experienceDAO = experienceDAO ?? new daoModule.ExperienceDAO(db)
        executionDAO = executionDAO ?? new daoModule.ExecutionDAO(db)
      }

      const handler = new TelegramCommandHandler({
        archiveDAO,
        experienceDAO,
        executionDAO,
        scheduleDAO: deps.scheduleDAO,
        enginePool: deps.enginePool,
        workflowService: deps.workflowService,
      })
      const reply = await handler.handle(command, chatId)

      const botToken = process.env.TELEGRAM_BOT_TOKEN
      if (botToken) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: reply }),
          })
        } catch (sendErr) {
          console.warn("[telegram] Failed to send reply:", sendErr)
        }
      }

      return c.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[telegram] Webhook error:", msg)
      return c.json({ ok: true }) // Always return 200 to Telegram
    }
  })

  return router
}
