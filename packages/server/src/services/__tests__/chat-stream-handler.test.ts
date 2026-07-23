import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest"
import { Hono } from "hono"
import { initDb, closeDb, getDb } from "../../db/connection"
import { applySchema } from "../../db/schema"
import path from "path"
import os from "os"
import fs from "fs"
import { ChatDAO } from "../../db/dao"
import { ChatService } from "../chat"
import { SSEService } from "../sse"
import { ChatStreamHandler } from "../chat-stream-handler"

const TEST_DB = path.join(os.tmpdir(), `chat-stream-handler-${Date.now()}.db`)
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
      sendQuery: mockSendQuery,
    })),
  }
})

let mockSendQuery: any = async function* () {
  yield { type: "text_delta", content: "default", messageId: "msg-1" }
  yield { type: "result", sessionId: "sess-1" }
}

function buildApp(handler: ChatStreamHandler): Hono {
  const app = new Hono()
  app.post("/test/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{ content: string }>()
    return handler.handleStream(c, {
      sessionId,
      content: body.content,
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
    })
  })
  return app
}

async function parseSSEEvents(response: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await response.text()
  const events: Array<{ event: string; data: any }> = []
  const lines = text.split("\n")
  let currentEvent = ""
  for (const line of lines) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(line.slice(5).trim()) })
      } catch {
        events.push({ event: currentEvent, data: line.slice(5).trim() })
      }
      currentEvent = ""
    }
  }
  return events
}

describe("ChatStreamHandler", () => {
  let chatService: ChatService
  let sessionId: string

  beforeEach(() => {
    const dao = new ChatDAO(getDb())
    chatService = new ChatService(dao, new SSEService())
    const session = chatService.createSession("test-workspace", "Handler Test")
    sessionId = session.id

    mockSendQuery = async function* () {
      yield { type: "text_delta", content: "default", messageId: "msg-1" }
      yield { type: "result", sessionId: "sess-1" }
    }
  })

  it("emits thinking lifecycle events in correct order", async () => {
    mockSendQuery = async function* () {
      yield { type: "message_start", messageId: "msg-1" }
      yield { type: "thinking_start", messageId: "msg-1" }
      yield { type: "thinking", content: "analyzing the request", messageId: "msg-1" }
      yield { type: "thinking_done", messageId: "msg-1" }
      yield { type: "text_delta", content: "Here is my answer", messageId: "msg-1" }
      yield { type: "result", sessionId: "sess-1", tokens: { input: 10, output: 5 } }
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    const events = await parseSSEEvents(res)
    const eventTypes = events.map(e => e.event)

    expect(eventTypes).toContain("thinking_start")
    expect(eventTypes).toContain("thinking")
    expect(eventTypes).toContain("thinking_done")
    expect(eventTypes).toContain("text_delta")
    expect(eventTypes).toContain("result")

    const thinkStartIdx = eventTypes.indexOf("thinking_start")
    const thinkIdx = eventTypes.indexOf("thinking")
    const thinkDoneIdx = eventTypes.indexOf("thinking_done")
    expect(thinkStartIdx).toBeLessThan(thinkIdx)
    expect(thinkIdx).toBeLessThan(thinkDoneIdx)

    const thinkingDoneEvent = events.find(e => e.event === "thinking_done")
    expect(thinkingDoneEvent?.data).toHaveProperty("thinkingDuration")

    const session = chatService.getSession(sessionId)
    const thinkingMsg = session!.messages.find(m => m.type === "thinking")
    expect(thinkingMsg).toBeDefined()
    const meta = JSON.parse(thinkingMsg!.metadata!)
    expect(meta.thinkingContent).toBe("analyzing the request")
    expect(meta.thinkingDone).toBe(true)
  })

  it("emits tool_call lifecycle events with correct metadata", async () => {
    mockSendQuery = async function* () {
      yield { type: "message_start", messageId: "msg-1" }
      yield { type: "tool_call_start", toolCallId: "tc-1", toolName: "Bash", messageId: "msg-1" }
      yield { type: "tool_call", toolCallId: "tc-1", toolName: "Bash", toolInput: { command: "ls -la" }, messageId: "msg-1" }
      yield { type: "tool_result", toolCallId: "tc-1", toolName: "Bash", content: "file1.txt\nfile2.txt", isError: false }
      yield { type: "text_delta", content: "Done!", messageId: "msg-1" }
      yield { type: "result", sessionId: "sess-1", tokens: { input: 20, output: 10 } }
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "list files" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    const events = await parseSSEEvents(res)
    const eventTypes = events.map(e => e.event)

    expect(eventTypes).toContain("tool_call_start")
    expect(eventTypes).toContain("tool_call")
    expect(eventTypes).toContain("tool_result")

    const tcStartIdx = eventTypes.indexOf("tool_call_start")
    const tcIdx = eventTypes.indexOf("tool_call")
    const trIdx = eventTypes.indexOf("tool_result")
    expect(tcStartIdx).toBeLessThan(tcIdx)
    expect(tcIdx).toBeLessThan(trIdx)

    const toolResultEvent = events.find(e => e.event === "tool_result")
    expect(toolResultEvent?.data).toHaveProperty("toolDuration")

    const session = chatService.getSession(sessionId)
    const toolMsg = session!.messages.find(m => m.type === "tool_call")
    expect(toolMsg).toBeDefined()
    const meta = JSON.parse(toolMsg!.metadata!)
    expect(meta.toolCallId).toBe("tc-1")
    expect(meta.toolName).toBe("Bash")
    expect(meta.toolStatus).toBe("done")
    expect(meta.toolResult).toBe("file1.txt\nfile2.txt")
  })

  it("handles ask_user_question events", async () => {
    mockSendQuery = async function* () {
      yield { type: "message_start", messageId: "msg-1" }
      yield { type: "tool_call_start", toolCallId: "tc-2", toolName: "AskUser", messageId: "msg-1" }
      yield { type: "tool_call", toolCallId: "tc-2", toolName: "AskUser", toolInput: {}, messageId: "msg-1" }
      yield { type: "ask_user_question", toolCallId: "tc-2", questions: [{ question: "Which option?" }] }
      yield { type: "result", sessionId: "sess-1" }
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "help me decide" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    const events = await parseSSEEvents(res)
    const askEvent = events.find(e => e.event === "ask_user_question")
    expect(askEvent).toBeDefined()

    const session = chatService.getSession(sessionId)
    const toolMsg = session!.messages.find(m => m.type === "tool_call")
    expect(toolMsg).toBeDefined()
    const meta = JSON.parse(toolMsg!.metadata!)
    expect(meta.toolStatus).toBe("done")
    expect(meta.displayType).toBe("ask_user_question")
  })

  it("classifies and emits error events correctly", async () => {
    mockSendQuery = async function* () {
      throw new Error("Unauthorized: Invalid API key (401)")
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    const events = await parseSSEEvents(res)
    const errorEvent = events.find(e => e.event === "error")
    expect(errorEvent).toBeDefined()
    expect(errorEvent!.data.code).toBe("auth")
    expect(errorEvent!.data.sessionId).toBe(sessionId)
  })

  it("classifies rate_limit errors", async () => {
    mockSendQuery = async function* () {
      throw new Error("Rate limit exceeded: 429 Too Many Requests")
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
      headers: { "Content-Type": "application/json" },
    })

    const events = await parseSSEEvents(res)
    const errorEvent = events.find(e => e.event === "error")
    expect(errorEvent!.data.code).toBe("rate_limit")
  })

  it("classifies timeout errors", async () => {
    mockSendQuery = async function* () {
      throw new Error("Request timeout: produced no output")
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
      headers: { "Content-Type": "application/json" },
    })

    const events = await parseSSEEvents(res)
    const errorEvent = events.find(e => e.event === "error")
    expect(errorEvent!.data.code).toBe("timeout")
  })

  it("persists full text and tokens on completion", async () => {
    mockSendQuery = async function* () {
      yield { type: "text_delta", content: "Hello ", messageId: "msg-1" }
      yield { type: "text_delta", content: "World", messageId: "msg-1" }
      yield { type: "result", sessionId: "new-sess", tokens: { input: 15, output: 8 }, costUsd: 0.001 }
    }

    const onComplete = vi.fn()
    const handler = new ChatStreamHandler(chatService, { onComplete })
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "greet me" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    await res.text()

    const session = chatService.getSession(sessionId)
    expect(session!.providerSessionId).toBe("new-sess")

    const textMsg = session!.messages.find(m => m.role === "assistant" && m.type === "text")
    expect(textMsg).toBeDefined()
    expect(textMsg!.content).toBe("Hello World")
    const meta = JSON.parse(textMsg!.metadata!)
    expect(meta.tokens).toEqual({ input: 15, output: 8 })
    expect(meta.costUsd).toBe(0.001)

    expect(onComplete).toHaveBeenCalledWith(sessionId, "Hello World")
  })

  it("emits SSE events with sessionId in every event", async () => {
    mockSendQuery = async function* () {
      yield { type: "message_start", messageId: "msg-1" }
      yield { type: "text_delta", content: "test", messageId: "msg-1" }
      yield { type: "result", sessionId: "sess-1" }
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "test" }),
      headers: { "Content-Type": "application/json" },
    })

    const events = await parseSSEEvents(res)
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.data).toHaveProperty("sessionId")
    }
    const nonResultEvents = events.filter(e => e.event !== "result")
    for (const event of nonResultEvents) {
      expect(event.data.sessionId).toBe(sessionId)
    }
  })

  it("handles tool_result with isError=true", async () => {
    mockSendQuery = async function* () {
      yield { type: "tool_call_start", toolCallId: "tc-err", toolName: "Bash", messageId: "msg-1" }
      yield { type: "tool_call", toolCallId: "tc-err", toolName: "Bash", toolInput: { command: "fail" }, messageId: "msg-1" }
      yield { type: "tool_result", toolCallId: "tc-err", toolName: "Bash", content: "command not found", isError: true }
      yield { type: "result", sessionId: "sess-1" }
    }

    const handler = new ChatStreamHandler(chatService)
    const app = buildApp(handler)

    const res = await app.request(`/test/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "run fail" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    await res.text()

    const session = chatService.getSession(sessionId)
    const toolMsg = session!.messages.find(m => m.type === "tool_call")
    const meta = JSON.parse(toolMsg!.metadata!)
    expect(meta.toolStatus).toBe("error")
  })
})
