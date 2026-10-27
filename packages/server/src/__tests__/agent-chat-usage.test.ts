// packages/server/src/__tests__/agent-chat-usage.test.ts
//
// 主对话 composer 指标闭环：
//  ① context_usage chunk → SSE 原样转发（ctx 角标不再停在 --%）；
//  ② result chunk → llm_calls 落账（tok 角标的数据源不再恒空）；
//  ③ context_usage 同时落 sessions 列 → 冷启动（刷新/重启服务/换浏览器）
//     时 GET /sessions/:id 能把它带回来，不必等下一轮。

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
import { createSessionRoutes } from "../routes/agent/sessions"
import { initSessionService } from "../services/agent/session-service"
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
  a.route("/api/agent", createSessionRoutes(sessionDAO))
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
  initSessionService(sessionDAO)
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

  it("persists context_usage on the session and serves it on a cold GET (lists stay lean)", async () => {
    installProvider([[
      { type: "context_usage", data: CTX },
      { type: "text_delta", content: "hello" },
      { type: "result", sessionId: "provider-sess", usage: USAGE, modelUsages: [{ model: MODEL, ...USAGE }] },
    ]])
    const res = await chat({ message: "E2E_TEST ctx", model: MODEL })
    expect(res.status).toBe(200)
    await res.text()

    const row = db.prepare("SELECT context_usage FROM sessions WHERE id='s-1'").get() as { context_usage: string | null }
    expect(JSON.parse(row.context_usage ?? "null")).toMatchObject({ percentage: 21, totalTokens: 42000 })

    // Cold load (refresh / server restart / another browser): the detail
    // endpoint hands the parsed payload back so the ctx chip can paint.
    const detail = await app().request("/api/agent/sessions/s-1?limit=50", {
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    })
    expect(detail.status).toBe(200)
    const body = await detail.json() as { context_usage?: { percentage?: number } }
    expect(body.context_usage?.percentage).toBe(21)

    // Sidebar payload stays lean — no per-session usage breakdown.
    const list = await app().request("/api/agent/sessions?limit=50", {
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    })
    const listBody = await list.json() as { items: Array<Record<string, unknown>> }
    expect(listBody.items[0].context_usage).toBeUndefined()
  })

  it("流式期间 running=true + partial 可续看，结束后原地 finalize", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(providers, "getProvider").mockImplementation((() => ({
      sendQuery: async function* () {
        sendQueryCalls += 1
        yield { type: "text_delta", content: "partial answer" }
        await gate
        yield { type: "result", sessionId: "provider-sess", usage: USAGE, modelUsages: [{ model: MODEL, ...USAGE }] }
      },
    })) as never)

    const resPromise = chat({ message: "E2E_TEST resume", model: MODEL })
    await new Promise((r) => setTimeout(r, 80))

    const running = await app().request("/api/agent/sessions/s-1/running")
    expect(await running.json()).toMatchObject({ running: true, partial: true })
    const streamingRows = db.prepare("SELECT content, metadata FROM messages WHERE role='assistant'").all() as Array<{ content: string; metadata: string | null }>
    expect(streamingRows).toHaveLength(1)
    expect(streamingRows[0].content).toBe("partial answer")
    expect(streamingRows[0].metadata).toContain('"streaming":true')

    release()
    const res = await resPromise
    await res.text()
    await new Promise((r) => setTimeout(r, 20))

    const after = await app().request("/api/agent/sessions/s-1/running")
    expect(await after.json()).toMatchObject({ running: false, partial: false })
    const finalRows = db.prepare("SELECT content, metadata FROM messages WHERE role='assistant'").all() as Array<{ content: string; metadata: string | null }>
    expect(finalRows).toHaveLength(1)
    expect(finalRows[0].content).toBe("partial answer")
    expect(finalRows[0].metadata).toBeNull()
  })
})
