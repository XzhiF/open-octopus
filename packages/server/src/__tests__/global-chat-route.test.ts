import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { initDb, closeDb, getDb } from "../db/connection"
import { applySchema } from "../db/schema"
import path from "path"
import os from "os"
import fs from "fs"
import { ChatDAO } from "../db/dao"
import { ChatService } from "../services/chat"
import { SSEService } from "../services/sse"

const TEST_DB = path.join(os.tmpdir(), `global-chat-route-${Date.now()}.db`)
beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)
})
afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

vi.mock("@octopus/providers", async () => {
  const actual = await vi.importActual("@octopus/providers")
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      getType: () => "claude",
      sendQuery: async function* () {
        yield { type: "message_start", messageId: "msg-g1" }
        yield { type: "thinking_start", messageId: "msg-g1" }
        yield { type: "thinking", content: "scheduler thinking", messageId: "msg-g1" }
        yield { type: "thinking_done", messageId: "msg-g1" }
        yield { type: "text_delta", content: "Scheduler response", messageId: "msg-g1" }
        yield { type: "result", sessionId: "global-sess-1", tokens: { input: 20, output: 10 } }
      },
    })),
  }
})

import app from "../index"

describe("Global Chat Route", () => {
  let sessionId: string

  beforeAll(() => {
    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const session = chatService.createSession("global-scheduler-chat", "Global Test")
    sessionId = session.id
  })

  it("POST /api/chat/global/sessions/:sessionId/messages returns SSE stream", async () => {
    const res = await app.request(`/api/chat/global/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "查看今天的定时任务" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)

    const text = await res.text()
    expect(text).toContain("event: thinking_start")
    expect(text).toContain("event: thinking\n")
    expect(text).toContain("event: thinking_done")
    expect(text).toContain("event: text_delta")
    expect(text).toContain("event: result")
    expect(text).toContain("Scheduler response")

    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const session = chatService.getSession(sessionId)
    expect(session).toBeDefined()
    const aiMessages = session!.messages.filter(m => m.role === "assistant")
    expect(aiMessages.length).toBeGreaterThan(0)
  })

  it("POST /api/chat/global/sessions/:sessionId/messages returns 404 for unknown session", async () => {
    const res = await app.request("/api/chat/global/sessions/nonexistent-session/messages", {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(404)
  })

  it("POST /api/chat/global/sessions creates session in global scope", async () => {
    const res = await app.request("/api/chat/global/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "New Global Session" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBeDefined()
    expect(data.workspaceId).toBe("global-scheduler-chat")
  })

  it("GET /api/chat/global/sessions lists global sessions", async () => {
    const res = await app.request("/api/chat/global/sessions")
    expect(res.status).toBe(200)
    const sessions = await res.json()
    expect(Array.isArray(sessions)).toBe(true)
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions.every((s: any) => s.workspaceId === "global-scheduler-chat")).toBe(true)
  })
})
