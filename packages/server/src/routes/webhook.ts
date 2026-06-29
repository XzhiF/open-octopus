// packages/server/src/routes/webhook.ts
import { Hono } from "hono"
import crypto from "crypto"
import type { ExperienceLifecycleService } from "../services/experience-lifecycle"

export function createWebhookRoutes(lifecycle: ExperienceLifecycleService) {
  const app = new Hono()

  app.post("/github", async (c) => {
    const secret = process.env.OCTOPUS_GITHUB_WEBHOOK_SECRET
    if (!secret) {
      console.warn("[webhook] GitHub webhook not configured")
      return c.json({ error: "GitHub webhook not configured" }, 503)
    }

    // Verify HMAC signature
    const signature = c.req.header("X-Hub-Signature-256")
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401)
    }

    const body = await c.req.text()
    const expectedSig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")

    // timingSafeEqual requires equal-length buffers
    if (signature.length !== expectedSig.length) {
      return c.json({ error: "Invalid signature" }, 401)
    }
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return c.json({ error: "Invalid signature" }, 401)
    }

    // Only process pull_request events
    const event = c.req.header("X-GitHub-Event")
    if (event !== "pull_request") {
      return c.json({ ok: true, ignored: true }, 200)
    }

    try {
      const payload = JSON.parse(body)

      // Only process closed + merged PRs
      if (payload.action !== "closed" || !payload.pull_request?.merged) {
        return c.json({ ok: true, ignored: true }, 200)
      }

      const prUrl = payload.pull_request.html_url
      const prBody = payload.pull_request.body || ""
      const resolvedCount = lifecycle.markResolved(prUrl, prBody)

      return c.json({ ok: true, resolved_count: resolvedCount }, 200)
    } catch (err) {
      console.error("[webhook] Failed to process GitHub event:", err)
      return c.json({ error: "Invalid payload" }, 400)
    }
  })

  return app
}
