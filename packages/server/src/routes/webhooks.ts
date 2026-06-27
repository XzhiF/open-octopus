// packages/server/src/routes/webhooks.ts
// GitHub Webhook route — Phase 4 of Execution Memory: PR merge → experience resolution.
// POST /api/webhooks/github — receives GitHub webhook events, resolves experiences on PR merge.

import { Hono } from "hono"
import crypto from "crypto"
import type { ExperienceLifecycleService } from "../services/experience-lifecycle"

export function createWebhookRoutes(lifecycleSvc: ExperienceLifecycleService): Hono {
  const routes = new Hono()

  routes.post("/github", async (c) => {
    try {
      // Verify required headers
      const signature = c.req.header("X-Hub-Signature-256")
      const event = c.req.header("X-GitHub-Event")

      if (!signature) {
        return c.json({ error: "Missing required header: X-Hub-Signature-256" }, 400)
      }

      const body = await c.req.text()

      // Verify HMAC signature if secret is configured
      const secret = process.env.GITHUB_WEBHOOK_SECRET
      if (secret) {
        const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
        // Both signature and expected must be same length for timingSafeEqual
        if (signature.length !== expected.length) {
          return c.json({ error: "Invalid webhook signature" }, 401)
        }
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          return c.json({ error: "Invalid webhook signature" }, 401)
        }
      }

      // Only process PR events
      if (event !== "pull_request") {
        return c.json({ resolved_count: 0 })
      }

      const payload = JSON.parse(body)

      // Only process merged PRs
      if (payload.action !== "closed" || !payload.pull_request?.merged) {
        return c.json({ resolved_count: 0 })
      }

      const prBody = payload.pull_request.body || ""
      const prUrl = payload.pull_request.html_url || ""

      const resolvedCount = lifecycleSvc.markResolved(prBody, prUrl)
      console.log(`[Webhook] PR merged: ${prUrl}, resolved ${resolvedCount} experiences`)

      return c.json({ resolved_count: resolvedCount })
    } catch (err: any) {
      console.error("[Webhook] GitHub webhook error:", err)
      return c.json({ error: err.message || "Internal Server Error" }, 500)
    }
  })

  return routes
}
