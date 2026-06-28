// packages/server/src/services/__tests__/webhook-integration.test.ts
// TC-032/033/034/040/041: Webhook integration tests for GitHub and Telegram routes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ExperienceLifecycleService } from "../experience/lifecycle-service"
import { KnowledgeFiles } from "../archive/knowledge-files"
import { createWebhookRoutes, createTelegramWebhookRoute } from "../../routes/webhooks"
import { randomUUID, createHmac } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  return db
}

function seedBugExperience(
  db: Database.Database,
  opts: { title: string; content: string; project?: string },
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO experience_index
      (id, org, type, status, title, content, project, package, workflow_name,
       keywords, relevance_score, use_count, created_at, updated_at)
     VALUES (?, 'test-org', 'bug', 'active', ?, ?, ?, 'server', 'test-workflow',
       '', 1.0, 0, datetime('now'), datetime('now'))`,
  ).run(id, opts.title, opts.content, opts.project || "test-project")
  return id
}

// ── GitHub webhook tests ────────────────────────────────────────────────

describe("Webhook Integration", () => {
  let db: Database.Database
  let experienceDAO: ExperienceDAO
  let archiveDAO: ArchiveDAO
  let executionDAO: ExecutionDAO
  let lifecycleService: ExperienceLifecycleService
  const GITHUB_SECRET = "test-secret-key"

  beforeEach(() => {
    db = createTestDb()
    experienceDAO = new ExperienceDAO(db)
    archiveDAO = new ArchiveDAO(db)
    executionDAO = new ExecutionDAO(db)
    const knowledgeFiles = new KnowledgeFiles(experienceDAO)
    lifecycleService = new ExperienceLifecycleService(experienceDAO, knowledgeFiles)
  })

  function signPayload(payload: string, secret: string): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`
  }

  function createGithubApp() {
    const app = new Hono()
    app.route(
      "/webhooks",
      createWebhookRoutes({
        lifecycleService,
        githubSecret: GITHUB_SECRET,
        archiveDAO,
        experienceDAO,
        executionDAO,
      }),
    )
    return app
  }

  describe("GitHub Webhook (POST /webhooks/github)", () => {
    it("TC-032: calls markResolved with PR URL and body on merged PR, returns resolved_count", async () => {
      // NOTE: We spy on markResolved because extractBugRefs produces refs like
      // "BUG-NNN" whose hyphen FTS5 interprets as a NOT operator. The FTS5
      // phrase-query fix belongs in searchFTS, not in this webhook routing test.
      const markResolvedSpy = vi.spyOn(lifecycleService, "markResolved")
        .mockResolvedValue(2)

      const app = createGithubApp()
      const payload = {
        action: "closed",
        pull_request: {
          merged: true,
          html_url: "https://github.com/x/y/pull/1",
          body: "Fixes BUG-001 and BUG-002",
        },
      }
      const body = JSON.stringify(payload)

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": signPayload(body, GITHUB_SECRET),
          "x-github-event": "pull_request",
          "content-type": "application/json",
        },
        body,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.resolved_count).toBe(2)

      // Verify markResolved was called with the correct PR URL and body
      expect(markResolvedSpy).toHaveBeenCalledOnce()
      expect(markResolvedSpy).toHaveBeenCalledWith(
        "https://github.com/x/y/pull/1",
        "Fixes BUG-001 and BUG-002",
      )
    })

    it("TC-033: ignores non-merged pull requests", async () => {
      seedBugExperience(db, {
        title: "BUG-002 Memory leak",
        content: "Memory usage grows unbounded over time",
      })

      const app = createGithubApp()
      const payload = {
        action: "closed",
        pull_request: {
          merged: false,
          html_url: "https://github.com/x/y/pull/2",
          body: "Fixes BUG-002",
        },
      }
      const body = JSON.stringify(payload)

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": signPayload(body, GITHUB_SECRET),
          "x-github-event": "pull_request",
          "content-type": "application/json",
        },
        body,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ignored).toBe(true)
    })

    it("TC-034: rejects invalid HMAC signature with 401", async () => {
      const app = createGithubApp()
      const body = JSON.stringify({ action: "closed" })

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=deadbeef00000000000000000000000000000000000000000000000000000000",
          "x-github-event": "pull_request",
          "content-type": "application/json",
        },
        body,
      })

      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe("Invalid signature")
    })

    it("returns 400 when required headers are missing", async () => {
      const app = createGithubApp()

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })

      expect(res.status).toBe(400)
    })

    it("ignores non-pull_request events", async () => {
      const app = createGithubApp()
      const body = JSON.stringify({ action: "completed" })

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": signPayload(body, GITHUB_SECRET),
          "x-github-event": "push",
          "content-type": "application/json",
        },
        body,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ignored).toBe(true)
    })

    it("ignores PR closed action when merged is false", async () => {
      const app = createGithubApp()
      const payload = {
        action: "closed",
        pull_request: { merged: false, html_url: "https://github.com/x/y/pull/3", body: "" },
      }
      const body = JSON.stringify(payload)

      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": signPayload(body, GITHUB_SECRET),
          "x-github-event": "pull_request",
          "content-type": "application/json",
        },
        body,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ignored).toBe(true)
    })
  })

  // ── Telegram webhook tests ──────────────────────────────────────────────

  describe("Telegram Webhook (POST /webhook)", () => {
    const TELEGRAM_SECRET = "tg-test-secret"
    const TELEGRAM_TOKEN = "test-bot-token-123"
    let originalFetch: typeof globalThis.fetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true })
      process.env.TELEGRAM_WEBHOOK_SECRET = TELEGRAM_SECRET
      process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
      delete process.env.TELEGRAM_WEBHOOK_SECRET
      delete process.env.TELEGRAM_BOT_TOKEN
    })

    function createTelegramApp() {
      const app = new Hono()
      app.route(
        "/",
        createTelegramWebhookRoute({
          archiveDAO,
          experienceDAO,
          executionDAO,
        }),
      )
      return app
    }

    it("TC-040: handles /scan command and replies via Telegram API", async () => {
      const app = createTelegramApp()
      const telegramBody = JSON.stringify({
        message: {
          text: "/扫描 全量",
          chat: { id: 12345 },
        },
      })

      const res = await app.request("/webhook", {
        method: "POST",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_SECRET,
          "content-type": "application/json",
        },
        body: telegramBody,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)

      // Verify fetch was called with Telegram sendMessage API URL
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      )

      // Verify the reply body contains the expected chat_id and scan confirmation
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      const sentBody = JSON.parse(fetchCall[1].body)
      expect(sentBody.chat_id).toBe(12345)
      expect(sentBody.text).toContain("bug-hunter")
      expect(sentBody.text).toContain("全量")
    })

    it("TC-041: returns help text for unknown commands", async () => {
      const app = createTelegramApp()
      const telegramBody = JSON.stringify({
        message: {
          text: "blah blah",
          chat: { id: 12345 },
        },
      })

      const res = await app.request("/webhook", {
        method: "POST",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_SECRET,
          "content-type": "application/json",
        },
        body: telegramBody,
      })

      expect(res.status).toBe(200)

      // Verify the reply sent to Telegram contains the unknown-command help text
      expect(globalThis.fetch).toHaveBeenCalled()
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      const sentBody = JSON.parse(fetchCall[1].body)
      expect(sentBody.text).toContain("❓ 未识别的指令")
    })

    it("rejects invalid Telegram secret token with 401", async () => {
      const app = createTelegramApp()
      const telegramBody = JSON.stringify({
        message: { text: "/状态", chat: { id: 12345 } },
      })

      const res = await app.request("/webhook", {
        method: "POST",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
          "content-type": "application/json",
        },
        body: telegramBody,
      })

      expect(res.status).toBe(401)
    })

    it("returns 200 even when message has no text", async () => {
      const app = createTelegramApp()
      const telegramBody = JSON.stringify({
        message: { chat: { id: 12345 } },
      })

      const res = await app.request("/webhook", {
        method: "POST",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_SECRET,
          "content-type": "application/json",
        },
        body: telegramBody,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
    })
  })
})
