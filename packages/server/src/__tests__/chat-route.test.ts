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
  const db = initDb(TEST_DB)
  applySchema(db)
})
afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../index"
import { WorkspaceService } from "../services/workspace"
import { getDb } from "../db/connection"
import { ChatService } from "../services/chat"
import { SSEService } from "../services/sse"

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

describe("Chat Route with LLM", () => {
  let workspaceId: string
  let sessionId: string
  let existingWsIds: Set<string>

  beforeAll(() => {
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    existingWsIds = new Set(wsService.list().map(ws => ws.id))

    const ws = wsService.create({ name: "chat-test", org: "xzf", path: "/tmp/octopus-chat-test" })
    workspaceId = ws.id

    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const session = chatService.createSession(workspaceId, "Test Chat")
    sessionId = session.id
  })

  afterAll(async () => {
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    const currentIds = wsService.list().map(ws => ws.id)
    for (const id of currentIds) {
      if (!existingWsIds.has(id)) {
        await wsService.delete(id)
      }
    }
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

    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const updated = chatService.getSession(sessionId)
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
    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const session = chatService.createSession(workspaceId, "User Message Test")

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

    const updated = chatService.getSession(session.id)
    const userMessages = updated!.messages.filter(m => m.role === 'user')
    expect(userMessages.length).toBeGreaterThan(0)
    expect(userMessages[0].content).toBe('test input')
  })

  it("updates provider_session_id after first AI response", async () => {
    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const session = chatService.createSession(workspaceId, "Session ID Test")

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

    const updated = chatService.getSession(session.id)
    expect(updated!.providerSessionId).toBe('test-session-1')
  })
})