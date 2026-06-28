import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import crypto from "crypto"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ArchiveService } from "../archive-service"
import { ExperienceLifecycleService } from "../experience-lifecycle"
import { createWebhookRoutes } from "../../routes/webhook"
import { Hono } from "hono"

// ============================================================================
// YAML chain schema validation
// ============================================================================

describe("YAML chain schema", () => {
  it("WorkflowSchema accepts valid chain config", async () => {
    const { WorkflowSchema } = await import("@octopus/shared")
    const workflow = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "test-workflow",
      chain: {
        on_success: [
          {
            workflow: "next-workflow.yaml",
            auto_trigger: true,
            input_mapping: { "parent.result": "$vars.output" },
          },
        ],
        on_failure: [
          {
            workflow: "cleanup.yaml",
            condition: "$vars.needs_cleanup == true",
            auto_trigger: false,
          },
        ],
      },
      nodes: [
        { id: "step-1", type: "bash", bash: "echo hello" },
      ],
    }

    const result = WorkflowSchema.safeParse(workflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.chain).toBeDefined()
      expect(result.data.chain.on_success).toHaveLength(1)
      expect(result.data.chain.on_failure).toHaveLength(1)
      expect(result.data.chain.on_success![0].workflow).toBe("next-workflow.yaml")
    }
  })

  it("WorkflowSchema accepts workflow without chain", async () => {
    const { WorkflowSchema } = await import("@octopus/shared")
    const workflow = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "simple-workflow",
      nodes: [
        { id: "step-1", type: "bash", bash: "echo hello" },
      ],
    }

    const result = WorkflowSchema.safeParse(workflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.chain).toBeUndefined()
    }
  })

  it("WorkflowChainSchema validates chain items", async () => {
    const { WorkflowChainSchema } = await import("@octopus/shared")

    // Valid chain
    const valid = WorkflowChainSchema.safeParse({
      on_success: [{ workflow: "next.yaml", auto_trigger: true }],
    })
    expect(valid.success).toBe(true)

    // Missing workflow field
    const invalid = WorkflowChainSchema.safeParse({
      on_success: [{ auto_trigger: true }],
    })
    expect(invalid.success).toBe(false)
  })
})

// ============================================================================
// GitHub Webhook
// ============================================================================

describe("GitHub Webhook", () => {
  let db: Database.Database
  let dbPath: string
  let experienceDAO: ExperienceDAO
  let lifecycle: ExperienceLifecycleService
  let app: Hono

  const WEBHOOK_SECRET = "test-secret-key"

  function signPayload(body: string): string {
    return "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-webhook-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = new Database(dbPath)
    db.pragma("foreign_keys = ON")
    applySchema(db)

    experienceDAO = new ExperienceDAO(db)
    const archiveDAO = new ArchiveDAO(db)
    const executionDAO = new ExecutionDAO(db)
    const tokenUsageDAO = new TokenUsageDAO(db)
    const archiveService = new ArchiveService(archiveDAO, executionDAO, tokenUsageDAO, experienceDAO)
    lifecycle = new ExperienceLifecycleService(experienceDAO, archiveDAO, archiveService)

    app = new Hono()
    app.route("/api/webhooks", createWebhookRoutes(lifecycle))

    // Set env variable for webhook secret
    process.env.OCTOPUS_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET
  })

  afterEach(() => {
    db.close()
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
    delete process.env.OCTOPUS_GITHUB_WEBHOOK_SECRET
  })

  it("returns 503 when webhook secret is not configured", async () => {
    delete process.env.OCTOPUS_GITHUB_WEBHOOK_SECRET

    const body = JSON.stringify({ action: "closed" })
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    })

    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.error).toBe("GitHub webhook not configured")
  })

  it("returns 401 when signature is missing", async () => {
    const body = JSON.stringify({ action: "closed" })
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
      },
      body,
    })

    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe("Missing signature")
  })

  it("returns 401 when signature is invalid", async () => {
    const body = JSON.stringify({ action: "closed" })
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalidsignature00000000000000000000000000000000000000000000000",
        "X-GitHub-Event": "pull_request",
      },
      body,
    })

    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe("Invalid signature")
  })

  it("ignores non-pull_request events", async () => {
    const body = JSON.stringify({ action: "completed" })
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Event": "push",
      },
      body,
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ignored).toBe(true)
  })

  it("ignores non-merged PRs", async () => {
    const payload = {
      action: "closed",
      pull_request: {
        merged: false,
        html_url: "https://github.com/org/repo/pull/1",
        body: "",
      },
    }
    const body = JSON.stringify(payload)
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ignored).toBe(true)
  })

  it("processes merged PR and resolves matching experiences", async () => {
    // Insert an experience that references BUG-001
    experienceDAO.insert({
      type: "bug",
      title: "BUG-001 crash on null",
      content: "Application crashes on null input. BUG-001",
      project: "test-project",
      status: "active",
      relevance_score: 10,
      use_count: 0,
    })

    const payload = {
      action: "closed",
      pull_request: {
        merged: true,
        html_url: "https://github.com/org/repo/pull/42",
        body: "Fixes BUG-001 by adding null check.",
      },
    }
    const body = JSON.stringify(payload)
    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Event": "pull_request",
      },
      body,
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.resolved_count).toBeGreaterThanOrEqual(1)
  })
})
