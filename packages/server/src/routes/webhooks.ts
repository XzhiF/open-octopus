import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import type { ExperienceLifecycleService } from "../services/experience/lifecycle-service"

interface WebhookDeps {
  lifecycleService: ExperienceLifecycleService
  githubSecret?: string
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

      return c.json({ ok: true, resolved: resolvedCount })
    } catch (err) {
      console.error("[webhooks] GitHub webhook processing failed:", err)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  return router
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const crypto = require("crypto")
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
