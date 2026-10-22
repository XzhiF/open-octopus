// packages/server/src/__tests__/agent-chat-usage.test.ts
//
// 主对话 composer 指标闭环：
//  ① context_usage chunk → SSE 原样转发（ctx 角标不再停在 --%）；
//  ② result chunk → llm_calls 落账（tok 角标的数据源不再恒空）。
// provider 边界 mock，DB / 路由 / 落账 helper 都是真件。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createChatRoutes } from "../routes/agent/chat-routes"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_agent-chat"
const TEST_DIR = path.join(os.tmpdir(), `agent-chat-usage-${Date.now()}`)
const MODEL = "E2E_TEST_agent-model"
const USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 }
const CTX = {
  categories: [{ name: "系统提示", tokens: 1200, color: "#D2A8FF" }],
  totalTokens: 42000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 21,
  model: "pro",
}

let db: Database.Database
let tokenDao: TokenUsageDAO
let sessionDAO: AgentSessionDAO
let streamQueue: Array<Array<Record<string, unknown>>>
let sendQueryCalls: number
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
      sendQueryCalls += 1
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
  return a
}

function chat(body: Record<string, unknown>) {
  return app().request("/api/agent/sessions/s-1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ system_prompt: "test", ...body }),
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
  sessionDAO = new AgentSessionDAO(db)
})

beforeEach(() => {
  db.prepare("DELETE FROM llm_calls").run()
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM sessions").run()
  sendQueryCalls = 0
  lastSendOptions = undefined
  process.env.OCTOPUS_HOME = TEST_DIR
  fs.mkdirSync(path.join(TEST_DIR, "agent", "memory"), { recursive: true })
  fs.mkdirSync(path.join(TEST_DIR, "agent", "experiences"), { recursive: true })
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: "s-1", org: ORG, title: "T", clone_name: null, session_type: "main",
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

describe("主对话 ctx / tok 数据链路", () => {
  it("转发 context_usage，并把 result 用量写入会话 llm_calls", async () => {
    installProvider([[
      { type: "context_usage", data: CTX },
      { type: "text_delta", content: "hello" },
      { type: "result", sessionId: "provider-sess", usage: USAGE, modelUsages: [{ model: MODEL, ...USAGE }] },
    ]])

    const res = await chat({
      message: "E2E_TEST hi",
      model: "E2E_TEST_agent-model",
      effort: "high",
      maxContext: "1m",
    })
    expect(res.status).toBe(200)
    const body = await res.text()

    expect(sendQueryCalls).toBe(1)
    expect(lastSendOptions).toMatchObject({
      model: "E2E_TEST_agent-model[1m]",
      effort: "high",
    })
    expect(body).toContain("event: context_usage")
    expect(body).toContain('"percentage":21')

    const rows = db.prepare("SELECT * FROM llm_calls").all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_path: "global_chat",
      session_id: "s-1",
      org: ORG,
      model: MODEL,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 200,
      cache_creation_tokens: 100,
    })
    expect(tokenDao.findLlmCallsBySession("s-1")).toHaveLength(1)
  })
})
