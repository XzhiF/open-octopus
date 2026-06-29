// packages/server/src/services/__tests__/telegram.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { parseTelegramCommand } from "../agent/telegram-commands"
import { TelegramHandler } from "../agent/telegram-handler"
import { createTelegramRoutes } from "../../routes/agent/telegram"
import { HermesProvider } from "@octopus/engine"

let db: Database.Database
let dbPath: string
let archiveDAO: ArchiveDAO
let executionDAO: ExecutionDAO
let experienceDAO: ExperienceDAO

const ORG = "xzf"
const WORKSPACE_ID = "ws-telegram-001"

function seedWorkspace() {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(WORKSPACE_ID, "test-ws", ORG, `/tmp/${WORKSPACE_ID}`, now, now)
}

function seedExecution(opts: { id: string; status?: string; workflowRef?: string; triggeredBy?: string }) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, triggered_by, org, created_at, updated_at, var_pool, duration, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, WORKSPACE_ID, "0", 0,
    opts.workflowRef ?? "test-workflow.yaml", opts.workflowRef ?? "Test Workflow",
    opts.status ?? "running", opts.triggeredBy ?? "manual", ORG, now, now,
    "{}", 1000, now, now,
  )
}

function seedArchive(opts: { executionId: string; status?: string; cost?: number }) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO execution_archive (
      execution_id, workflow_ref, workflow_name, status,
      started_at, completed_at, duration_ms,
      total_input_tokens, total_output_tokens, total_cost_usd,
      node_summary, vars_snapshot, workspace_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.executionId, "test-wf.yaml", "Test Workflow", opts.status ?? "completed",
    now, now, 1000, 100, 50, opts.cost ?? 0.01,
    "{}", "{}", WORKSPACE_ID, now,
  )
}

function seedExperience(opts: { type: string; title: string; content: string }) {
  const now = new Date().toISOString()
  const result = db.prepare(
    `INSERT INTO experience_index (type, title, content, project, package, keywords, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(opts.type, opts.title, opts.content, "test-project", "test-pkg", opts.title, now)
  return Number(result.lastInsertRowid)
}

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-"))
  dbPath = path.join(tmpDir, "test.db")
  db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  applySchema(db)
  archiveDAO = new ArchiveDAO(db)
  executionDAO = new ExecutionDAO(db)
  experienceDAO = new ExperienceDAO(db)
  seedWorkspace()
})

afterEach(() => {
  db.close()
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }) } catch {}
})

// ── P5.2: Command Parser Tests ─────────────────────────────────────────────

describe("parseTelegramCommand", () => {
  it("parses /scan with scope", () => {
    const result = parseTelegramCommand("/scan engine")
    expect(result.command).toBe("scan")
    expect(result.args.scope).toBe("engine")
  })

  it("parses /develop with description", () => {
    const result = parseTelegramCommand("/develop add user login")
    expect(result.command).toBe("develop")
    expect(result.args.description).toBe("add user login")
  })

  it("parses /status", () => {
    const result = parseTelegramCommand("/status")
    expect(result.command).toBe("status")
  })

  it("parses /report", () => {
    const result = parseTelegramCommand("/report")
    expect(result.command).toBe("report")
  })

  it("parses /experience with keyword", () => {
    const result = parseTelegramCommand("/experience bug")
    expect(result.command).toBe("experience")
    expect(result.args.keyword).toBe("bug")
  })

  it("parses /register with workflow and cron", () => {
    const result = parseTelegramCommand("/register bug-hunter 0")
    expect(result.command).toBe("register")
    expect(result.args.workflow).toBe("bug-hunter")
    expect(result.args.cron).toBe("0")
  })

  it("parses /stop with execution ID", () => {
    const result = parseTelegramCommand("/stop abc-123")
    expect(result.command).toBe("stop")
    expect(result.args.executionId).toBe("abc-123")
  })

  it("returns unknown for unrecognized input", () => {
    const result = parseTelegramCommand("hello world")
    expect(result.command).toBe("unknown")
  })

  // Natural language commands
  it("parses 扫描 as scan", () => {
    const result = parseTelegramCommand("扫描 engine")
    expect(result.command).toBe("scan")
    expect(result.args.scope).toBe("engine")
  })

  it("parses 状态 as status", () => {
    const result = parseTelegramCommand("状态")
    expect(result.command).toBe("status")
  })

  it("parses 报告 as report", () => {
    const result = parseTelegramCommand("报告")
    expect(result.command).toBe("report")
  })

  it("parses 经验 as experience", () => {
    const result = parseTelegramCommand("经验 bug")
    expect(result.command).toBe("experience")
    expect(result.args.keyword).toBe("bug")
  })

  it("parses 注册 as register", () => {
    const result = parseTelegramCommand("注册 bug-hunter 0")
    expect(result.command).toBe("register")
    expect(result.args.workflow).toBe("bug-hunter")
    expect(result.args.cron).toBe("0")
  })

  it("parses 停止 as stop", () => {
    const result = parseTelegramCommand("停止 abc-123")
    expect(result.command).toBe("stop")
    expect(result.args.executionId).toBe("abc-123")
  })

  it("parses 开发 as develop", () => {
    const result = parseTelegramCommand("开发 add feature")
    expect(result.command).toBe("develop")
    expect(result.args.description).toBe("add feature")
  })
})

// ── P5.3: Handler Tests ────────────────────────────────────────────────────

describe("TelegramHandler", () => {
  let handler: TelegramHandler
  let sentReplies: Array<{ chatId: number; text: string }>

  beforeEach(() => {
    sentReplies = []
    handler = new TelegramHandler({
      experienceDAO,
      archiveDAO,
      executionDAO,
      sendReply: async (chatId: number, text: string) => {
        sentReplies.push({ chatId, text })
      },
    })
  })

  it("status command returns running executions", async () => {
    seedExecution({ id: "exec-1", status: "running", workflowRef: "bug-hunter.yaml" })
    seedExecution({ id: "exec-2", status: "running", workflowRef: "prd-impl.yaml" })

    const reply = await handler.handleMessage(123, "/status", { id: 1, first_name: "Test" })

    expect(reply).toContain("运行中")
    expect(reply).toContain("2")
    expect(sentReplies).toHaveLength(1)
    expect(sentReplies[0].chatId).toBe(123)
  })

  it("status command returns empty message when no running executions", async () => {
    const reply = await handler.handleMessage(123, "/status", { id: 1, first_name: "Test" })
    expect(reply).toContain("没有运行中")
  })

  it("report command returns stats", async () => {
    seedArchive({ executionId: "arc-1", status: "completed", cost: 1.5 })
    seedArchive({ executionId: "arc-2", status: "completed", cost: 2.5 })

    const reply = await handler.handleMessage(123, "/report", { id: 1, first_name: "Test" })

    expect(reply).toContain("7天报告")
    expect(reply).toContain("总执行: 2")
    expect(reply).toContain("成功率: 100.0%")
    expect(reply).toContain("$4.00")
  })

  it("experience search returns matching results", async () => {
    seedExperience({ type: "bug", title: "login bug fix", content: "Fixed null pointer in login module" })
    seedExperience({ type: "pattern", title: "auth pattern", content: "Use JWT for authentication" })

    const reply = await handler.handleMessage(123, "/experience login", { id: 1, first_name: "Test" })

    expect(reply).toContain("经验搜索结果")
    expect(reply).toContain("login bug fix")
  })

  it("experience search returns empty message when no results", async () => {
    const reply = await handler.handleMessage(123, "/experience nonexistent", { id: 1, first_name: "Test" })
    expect(reply).toContain("未找到匹配")
  })

  it("experience command requires keyword", async () => {
    const reply = await handler.handleMessage(123, "/experience", { id: 1, first_name: "Test" })
    expect(reply).toContain("用法")
  })

  it("unknown command returns help message", async () => {
    const reply = await handler.handleMessage(123, "hello there", { id: 1, first_name: "Test" })

    expect(reply).toContain("支持的指令")
    expect(reply).toContain("扫描")
    expect(reply).toContain("开发")
    expect(reply).toContain("状态")
    expect(reply).toContain("报告")
  })

  it("stop command lists running executions when no ID given", async () => {
    seedExecution({ id: "exec-stop-1", status: "running", workflowRef: "test.yaml" })

    const reply = await handler.handleMessage(123, "/stop", { id: 1, first_name: "Test" })
    expect(reply).toContain("运行中的执行")
    expect(reply).toContain("exec-stop-1")
  })

  it("develop command requires description", async () => {
    const reply = await handler.handleMessage(123, "/develop", { id: 1, first_name: "Test" })
    expect(reply).toContain("用法")
  })

  it("register command requires workflow", async () => {
    const reply = await handler.handleMessage(123, "/register", { id: 1, first_name: "Test" })
    expect(reply).toContain("用法")
  })
})

// ── P5.1: Webhook Tests ────────────────────────────────────────────────────

describe("Telegram Webhook", () => {
  const SECRET = "test-secret-token"
  const BOT_TOKEN = "123456:ABC"

  function createApp(configured: boolean = true) {
    const handlerMock = {
      handleMessage: vi.fn().mockResolvedValue("ok"),
    }
    const app = createTelegramRoutes({
      getConfig: () => configured ? { botToken: BOT_TOKEN, secretToken: SECRET } : null,
      handler: handlerMock,
    })
    return { app, handlerMock }
  }

  async function postWebhook(app: ReturnType<typeof createTelegramRoutes>, body: unknown, secretHeader?: string) {
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secretHeader ? { "X-Telegram-Bot-Api-Token": secretHeader } : {}),
      },
      body: JSON.stringify(body),
    })
    return app.fetch(req)
  }

  it("returns 503 when not configured", async () => {
    const { app } = createApp(false)
    const res = await postWebhook(app, { message: { text: "hi", chat: { id: 1 } } }, SECRET)
    expect(res.status).toBe(503)
  })

  it("returns 401 for invalid secret token", async () => {
    const { app } = createApp(true)
    const res = await postWebhook(app, { message: { text: "hi", chat: { id: 1 } } }, "wrong-secret")
    expect(res.status).toBe(401)
  })

  it("returns 401 when no secret provided", async () => {
    const { app } = createApp(true)
    const res = await postWebhook(app, { message: { text: "hi", chat: { id: 1 } } })
    expect(res.status).toBe(401)
  })

  it("returns 400 for invalid payload (no text)", async () => {
    const { app } = createApp(true)
    const res = await postWebhook(app, { message: { chat: { id: 1 } } }, SECRET)
    expect(res.status).toBe(400)
  })

  it("returns 400 for invalid payload (no chat id)", async () => {
    const { app } = createApp(true)
    const res = await postWebhook(app, { message: { text: "hi" } }, SECRET)
    expect(res.status).toBe(400)
  })

  it("returns 200 for valid payload and calls handler asynchronously", async () => {
    const { app, handlerMock } = createApp(true)
    const res = await postWebhook(app, {
      message: {
        text: "/status",
        chat: { id: 12345 },
        from: { id: 1, first_name: "Test", username: "testuser" },
      },
    }, SECRET)

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)

    // Handler is called asynchronously — wait for it
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handlerMock.handleMessage).toHaveBeenCalledWith(
      12345, "/status", expect.objectContaining({ id: 1, first_name: "Test" }),
    )
  })

  it("accepts secret_token from body as fallback", async () => {
    const { app } = createApp(true)
    const res = await postWebhook(app, {
      secret_token: SECRET,
      message: { text: "/status", chat: { id: 12345 } },
    })
    expect(res.status).toBe(200)
  })
})

// ── P5.6: Hermes dual-mode Tests ───────────────────────────────────────────

describe("HermesProvider dual-mode", () => {
  it("detects dynamic mode for telegram:{digits} target", () => {
    const provider = new HermesProvider("test-hermes", { type: "hermes", timeout: 15, min_severity: "info", method: "POST" })
    // Dynamic mode requires OCTOPUS_TELEGRAM_BOT_TOKEN — without it, should fail with that error
    const originalToken = process.env.OCTOPUS_TELEGRAM_BOT_TOKEN
    delete process.env.OCTOPUS_TELEGRAM_BOT_TOKEN

    const resultPromise = provider.send(
      { severity: "info", title: "Test", body: "body" },
      { target: "telegram:123456789", timeout: 5 },
    )

    return resultPromise.then(result => {
      expect(result.success).toBe(false)
      expect(result.error).toContain("OCTOPUS_TELEGRAM_BOT_TOKEN")
      // Restore
      if (originalToken) process.env.OCTOPUS_TELEGRAM_BOT_TOKEN = originalToken
    })
  })

  it("uses named mode (CLI) for telegram:{name} target", async () => {
    const provider = new HermesProvider("test-hermes", { type: "hermes", timeout: 15, min_severity: "info", method: "POST" })

    // Named mode uses hermes CLI which will fail in test — just check it doesn't attempt Bot API
    const result = await provider.send(
      { severity: "info", title: "Test", body: "body" },
      { target: "telegram:xzf_channel", timeout: 1, cliPath: "/nonexistent/hermes" },
    )

    // Should fail because CLI path doesn't exist — but it tried CLI, not Bot API
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    // The error should be from execFile, not about BOT_TOKEN
    expect(result.error).not.toContain("OCTOPUS_TELEGRAM_BOT_TOKEN")
  })

  it("uses CLI for non-telegram targets", async () => {
    const provider = new HermesProvider("test-hermes", { type: "hermes", timeout: 15, min_severity: "info", method: "POST" })

    const result = await provider.send(
      { severity: "info", title: "Test", body: "body" },
      { target: "slack:general", timeout: 1, cliPath: "/nonexistent/hermes" },
    )

    expect(result.success).toBe(false)
    // Should be a CLI error, not telegram-related
    expect(result.error).not.toContain("Telegram")
  })
})
