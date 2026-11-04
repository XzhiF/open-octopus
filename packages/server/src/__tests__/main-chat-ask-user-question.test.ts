// packages/server/src/__tests__/main-chat-ask-user-question.test.ts
//
// 2026-11-02 回归：任务线程搬进主对话后（8cd7a49b），chat-routes 漏了
// interactionSession 开关 —— SDK 在 headless 下直接「执行」AskUserQuestion
// 并回空 answers，模型把「用户没回答」当默认继续跑完。
//
// 本测试钉住两段承重：
//   ① sendQuery 必须带 interactionSession: true（否则 canUseTool 默认放行）；
//   ② provider 的 ask_user_question chunk 必须转成同名 SSE 事件（前端据此
//      补全 toolCall，回合结束后渲染可回答的问题卡）。

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
import { initSessionService } from "../services/agent/session-service"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_main_chat_ask"
const TEST_DIR = path.join(os.tmpdir(), `main-chat-ask-${Date.now()}`)

const QUESTIONS = {
  questions: [
    {
      question: "登录功能的最小形态，你要哪一种？",
      header: "登录形态",
      multiSelect: false,
      options: [
        { label: "用户名+密码换 JWT（推荐）", description: "最接近真实登录的形态。" },
        { label: "仅用户名登录（demo 简化）", description: "最薄，只适合演示。" },
      ],
    },
  ],
}

let db: Database.Database
let tokenDao: TokenUsageDAO
let sessionDAO: AgentSessionDAO
let chunks: Array<Record<string, unknown>>
let lastSendOptions: Record<string, unknown> | undefined

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options: Record<string, unknown>,
    ) {
      lastSendOptions = options
      for (const chunk of chunks) yield chunk
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

function chat() {
  return app().request("/api/agent/sessions/s-1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message: "我现在需要开发登录功能" }),
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
  lastSendOptions = undefined
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

describe("主对话 AskUserQuestion 交互接管", () => {
  it("sendQuery 带 interactionSession: true", async () => {
    chunks = [{ type: "text_delta", content: "ok" }, { type: "result", content: "ok", sessionId: "sdk-1" }]
    installProvider()

    const res = await chat()
    expect(res.status).toBe(200)
    await res.text()

    expect(lastSendOptions?.interactionSession).toBe(true)
  })

  it("ask_user_question chunk 转成同名 SSE 事件（问题可恢复成卡）", async () => {
    chunks = [
      { type: "ask_user_question", toolCallId: "tc-ask", questions: QUESTIONS },
      { type: "text_delta", content: "先停在这里等你回答。" },
      { type: "result", content: "先停在这里等你回答。", sessionId: "sdk-1" },
    ]
    installProvider()

    const res = await chat()
    expect(res.status).toBe(200)
    const text = await res.text()

    expect(text).toContain("event: ask_user_question")
    expect(text).toContain('"tool_call_id":"tc-ask"')
    expect(text).toContain("登录形态")
  })
})
