// Per-turn SDK debug recorder + dock inspector API.
//
//  ① chat route writes exactly one session_turn_debug row per turn with the
//    ACTUAL provider message, system-prompt append, sendQuery options, the SDK
//    system:init snapshot and getContextUsage();
//  ② the list endpoint returns summaries only (newest first);
//  ③ the detail endpoint returns the full snapshot + ledger cost;
//  ④ a role switch is marked has_switch and carries the delivered card;
//  ⑤ an interrupted turn is finalized as interrupted (never stuck "running").

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, SessionCacheContextDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createChatRoutes } from "../routes/agent/chat-routes"
import { createDebugRoutes } from "../routes/agent/debug-routes"
import { initSessionService } from "../services/agent/session-service"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_turn-debug"
const TEST_DIR = path.join(os.tmpdir(), `turn-debug-${Date.now()}`)
const MODEL = "E2E_TEST_agent-model"
const USAGE = { inputTokens: 800, outputTokens: 400, cacheReadTokens: 2000, cacheCreationTokens: 100 }
const CTX = {
  categories: [
    { name: "System prompt", tokens: 6000, color: "#D2A8FF" },
    { name: "Messages", tokens: 1200, color: "#4FD1D9" },
    { name: "Free space", tokens: 192800, color: "#26262E" },
  ],
  totalTokens: 7200,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 3.6,
  model: "pro",
  systemPromptSections: [{ name: "append", tokens: 900 }],
}
const INIT = {
  claudeCodeVersion: "2.1.250",
  model: "pro",
  cwd: "/tmp/ws",
  permissionMode: "default",
  outputStyle: "default",
  tools: ["Read", "Bash", "Grep"],
  mcpServers: [{ name: "octopus-workflow", status: "connected" }],
  agents: ["workspace"],
  skills: ["octo-ui-review"],
  plugins: [{ name: "task-author", path: "/tmp/task-author", version: "1.0.0" }],
  slashCommands: ["compact", "context"],
}

let db: Database.Database
let tokenDao: TokenUsageDAO
let sessionDAO: AgentSessionDAO
let streamQueue: Array<Array<Record<string, unknown>>>
let lastSendOptions: Record<string, unknown> | undefined

function installProvider(chunks: Array<Array<Record<string, unknown>>>) {
  streamQueue = chunks
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options: Record<string, unknown>,
    ) {
      lastSendOptions = options
      const next = streamQueue.shift() ?? []
      for (const c of next) yield c
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route("/api/agent", createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao: tokenDao,
  }))
  a.route("/api/agent", createDebugRoutes({ sessionDAO, tokenUsageDAO: tokenDao }))
  return a
}

function chat(body: Record<string, unknown> = {}) {
  return app().request("/api/agent/sessions/s-1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message: "原始用户消息", system_prompt: "测试 system prompt", ...body }),
  })
}

function debugRows() {
  return db.prepare("SELECT * FROM session_turn_debug ORDER BY turn_index").all() as Array<Record<string, any>>
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
  sessionDAO = new AgentSessionDAO(db)
  initSessionService(sessionDAO)
})

beforeEach(() => {
  db.prepare("DELETE FROM llm_calls").run()
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM sessions").run()
  db.prepare("DELETE FROM session_prompt_snapshots").run()
  db.prepare("DELETE FROM session_role_states").run()
  db.prepare("DELETE FROM session_turn_debug").run()
  db.prepare("DELETE FROM billing_price_config").run()
  const priceNow = new Date().toISOString()
  db.prepare(`INSERT INTO billing_price_config
    (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES ('price-1', 'test', ?, 1, 1, 1, 1, 'USD', NULL, NULL, ?, ?)`).run(MODEL, priceNow, priceNow)
  process.env.OCTOPUS_HOME = TEST_DIR
  fs.mkdirSync(path.join(TEST_DIR, "agent", "memory"), { recursive: true })
  fs.mkdirSync(path.join(TEST_DIR, "agent", "experiences"), { recursive: true })
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: "s-1", repo_group: ORG, title: "T", clone_name: null, session_type: "main",
    created_at: now, updated_at: now,
  })
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* non-fatal */ }
  db.close()
})

describe("session turn debug — recorder + inspector API", () => {
  it("records provider message / system prompt / SDK init / context usage / usage", async () => {
    installProvider([[
      { type: "system_init", data: INIT },
      { type: "context_usage", data: CTX },
      { type: "text_delta", content: "hello" },
      { type: "result", sessionId: "provider-sess", usage: USAGE, modelUsages: [{ model: MODEL, ...USAGE }] },
    ]])

    const res = await chat()
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("done")

    const rows = debugRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.turn_index).toBe(1)
    expect(row.status).toBe("ok")
    expect(row.provider_message).toBe("原始用户消息")
    expect(row.system_prompt).toBe("测试 system prompt")
    expect(row.model).toBeNull()

    const init = JSON.parse(row.system_init)
    expect(init.tools).toEqual(["Read", "Bash", "Grep"])
    expect(init.mcpServers[0]).toMatchObject({ name: "octopus-workflow", status: "connected" })

    const ctx = JSON.parse(row.context_usage)
    expect(ctx.percentage).toBe(3.6)
    expect(ctx.systemPromptSections).toEqual([{ name: "append", tokens: 900 }])

    const usage = JSON.parse(row.usage)
    expect(usage.totalTokens).toBe(3300)
    expect(usage.models[0].model).toBe(MODEL)

    const events = JSON.parse(row.events)
    expect(events.some((e: any) => e.label === "SDK init")).toBe(true)
    expect(events.some((e: any) => e.label === "context_usage")).toBe(true)
    expect(events[events.length - 1].label).toBe("turn done")

    // sendQuery options carried the preset append + stable surfaces
    expect(lastSendOptions?.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: "测试 system prompt" })
    const options = JSON.parse(row.sdk_options)
    expect(options).toMatchObject({
      systemPrompt: { type: "preset", preset: "claude_code", appendChars: "测试 system prompt".length },
      interruptible: true,
      settingSources: ["project", "user"],
    })

    // List = summaries only (newest first), detail = full payload + cost.
    const listRes = await app().request("/api/agent/debug/sessions/s-1/turns")
    expect(listRes.status).toBe(200)
    const list = await listRes.json() as any
    expect(list.total).toBe(1)
    expect(list.turns[0]).toMatchObject({ turn_index: 1, status: "ok", has_switch: false })
    expect(list.turns[0]).not.toHaveProperty("provider_message")
    expect(list.turns[0]).not.toHaveProperty("system_prompt")
    expect(list.turns[0].usage.costUsd).toBeCloseTo(0.0033, 6)
    expect(list.turns[0].usage.costComplete).toBe(true)

    const detailRes = await app().request("/api/agent/debug/sessions/s-1/turns/1")
    expect(detailRes.status).toBe(200)
    const detail = await detailRes.json() as any
    expect(detail.user_message).toBe("原始用户消息")
    expect(detail.provider_message).toBe("原始用户消息")
    expect(detail.system_prompt).toBe("测试 system prompt")
    expect(detail.system_prompt_frozen).toBe(false) // no snapshot written by system_prompt override
    expect(detail.ledger_calls).toHaveLength(1)
    expect(detail.ledger_calls[0]).toMatchObject({ model: MODEL, input_tokens: 800, output_tokens: 400 })
    expect(detail.usage.costUsd).toBeCloseTo(0.0033, 6)
  })

  it("marks a role-switch turn and keeps the delivered card", async () => {
    const cacheCtx = new SessionCacheContextDAO(db)
    cacheCtx.setActiveExpert("s-1", "workspace", "clone")
    installProvider([[
      { type: "text_delta", content: "ok" },
      { type: "result", usage: USAGE, modelUsages: [{ model: MODEL, ...USAGE }] },
    ]])

    const res = await chat()
    expect((await res.text())).toContain("done")

    const row = debugRows()[0]
    expect(row.role_revision).toBe(1)
    expect(row.role_card).toContain("角色切换")
    expect(row.provider_message).toContain("<system-reminder>")

    const list = await (await app().request("/api/agent/debug/sessions/s-1/turns")).json() as any
    expect(list.turns[0].has_switch).toBe(true)
    expect(list.turns[0].identity).toMatchObject({ kind: "clone", id: "workspace", revision: 1 })

    const detail = await (await app().request("/api/agent/debug/sessions/s-1/turns/1")).json() as any
    expect(detail.role_card).toContain("角色切换")
    expect(detail.has_switch).toBe(true)
  })

  it("finalizes an interrupted result as interrupted (with usage)", async () => {
    installProvider([[
      { type: "text_delta", content: "partial" },
      {
        type: "error",
        code: "error_during_execution",
        message: "aborted_streaming",
        sdkTerminalReason: "aborted_streaming",
        usage: USAGE,
        modelUsages: [{ model: MODEL, ...USAGE }],
      },
    ]])

    const res = await chat()
    await res.text()

    const row = debugRows()[0]
    // The provider stream ends without a result → generated=false, but the
    // error chunk carried real usage; the row must not stay「running」.
    expect(row.status).toBe("error")
    expect(JSON.parse(row.usage).totalTokens).toBe(3300)
    expect(row.ended_at).toBeTruthy()
    expect(row.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("returns 404 for unknown sessions and unrecorded turns", async () => {
    const missing = await app().request("/api/agent/debug/sessions/nope/turns")
    expect(missing.status).toBe(404)
    const turn = await app().request("/api/agent/debug/sessions/s-1/turns/9")
    expect(turn.status).toBe(404)
  })
})