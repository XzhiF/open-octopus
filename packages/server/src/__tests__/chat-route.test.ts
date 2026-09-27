// P1 B1: ChatDAO 已 postgres.js —— 本文件保持 SQLite(:memory:) 承接未迁域
// （workspace 等 B5 表），同时注册随机 PG 测试库给 chat 链路（整 app 经 registry
// 的 pgSql() 取池；测试侧直接构造 ChatService 用 pg.sql）。用例语义与条数不变。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { initDb, closeDb } from "../db/connection"
import { applySchema } from "../db/schema"
import path from "path"
import os from "os"
import { ChatDAO, WorkspaceDAO } from '../db/dao'
import fs from "fs"

// Initialize isolated test database BEFORE importing index.ts
const TEST_DB = path.join(os.tmpdir(), `chat-route-test-${Date.now()}.db`)
beforeAll(() => {
  if (!pgTestEnabledOn()) return
  const db = initDb(TEST_DB)
  applySchema(db)
})
afterAll(() => {
  if (!pgTestEnabledOn()) return
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../index"
import { WorkspaceService } from "../services/workspace"
import { getDb } from "../db/connection"
import { ChatService } from "../services/chat"
import { SSEService } from "../services/sse"
import { describePg, pgTestEnabledOn, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

vi.mock("@octopus/providers", async () => {
  const actual = await vi.importActual("@octopus/providers")
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      getType: () => 'claude',
      sendQuery: async function* () {
        const msgId = 'msg-test-1'
        yield { type: 'message_start', messageId: msgId }
        yield { type: 'text_delta', content: 'Hello from AI', messageId: msgId }
        yield { type: 'text_done', messageId: msgId }
        yield { type: 'message_stop', messageId: msgId }
        yield { type: 'result', sessionId: 'test-session-1', tokens: { input: 10, output: 5 } }
      },
    })),
  }
})

describePg("Chat Route with LLM", () => {
  let pg: PgFixture
  let workspaceId: string
  let sessionId: string
  let existingWsIds: Set<string>

  const chatService = () => new ChatService(new ChatDAO(pg.sql), new SSEService())

  beforeAll(async () => {
    pg = await setupRegisteredPgSchema() // 注册为当前池：整 app 的 d.chat(lazyDAO→pgSql) 用同座库
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    existingWsIds = new Set(wsService.list().map(ws => ws.id))

    const ws = wsService.create({ name: "chat-test", org: "xzf", path: "/tmp/octopus-chat-test" })
    workspaceId = ws.id

    const session = await chatService().createSession(workspaceId, "Test Chat")
    sessionId = session.id
  }, 30000)

  afterAll(async () => {
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    const currentIds = wsService.list().map(ws => ws.id)
    for (const id of currentIds) {
      if (!existingWsIds.has(id)) {
        await wsService.delete(id)
      }
    }
    await pg.close()
  })

  it("POST /messages returns 200 and creates AI response", async () => {
    const res = await app.request(
      `/api/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
        headers: { "Content-Type": "application/json" },
      }
    )

    expect(res.status).toBe(200)

    // Consume SSE stream to ensure stream completes
    await res.text()

    const updated = await chatService().getSession(sessionId)
    expect(updated).toBeDefined()
    const aiMessages = updated!.messages.filter(m => m.role === 'assistant')
    expect(aiMessages.length).toBeGreaterThan(0)
    expect(aiMessages[0].content).toBe('Hello from AI')
  })

  it("POST /messages returns 404 for unknown session", async () => {
    const res = await app.request(
      `/api/workspaces/${workspaceId}/chat/sessions/nonexistent-session/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "user", content: "hello" }),
        headers: { "Content-Type": "application/json" },
      }
    )
    expect(res.status).toBe(404)
  })

  it("POST /messages stores user message first", async () => {
    const session = await chatService().createSession(workspaceId, "User Message Test")

    const res = await app.request(
      `/api/workspaces/${workspaceId}/chat/sessions/${session.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: "test input" }),
        headers: { "Content-Type": "application/json" },
      }
    )

    // Consume SSE stream
    await res.text()

    const updated = await chatService().getSession(session.id)
    const userMessages = updated!.messages.filter(m => m.role === 'user')
    expect(userMessages.length).toBeGreaterThan(0)
    expect(userMessages[0].content).toBe('test input')
  })

  it("updates provider_session_id after first AI response", async () => {
    const session = await chatService().createSession(workspaceId, "Session ID Test")

    const res = await app.request(
      `/api/workspaces/${workspaceId}/chat/sessions/${session.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
        headers: { "Content-Type": "application/json" },
      }
    )

    expect(res.status).toBe(200)

    // Consume SSE stream to ensure stream completes
    await res.text()

    const updated = await chatService().getSession(session.id)
    expect(updated!.providerSessionId).toBe('test-session-1')
  })
})
