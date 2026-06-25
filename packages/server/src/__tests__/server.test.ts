import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { initDb, closeDb } from "../db/connection"
import { applySchema } from "../db/schema"
import { WorkspaceDAO } from '../db/dao'
import path from "path"
import os from "os"
import fs from "fs"

// Initialize isolated test database BEFORE importing index.ts
// This prevents inheriting OCTOPUS_DB_PATH from parent process
const TEST_DB = path.join(os.tmpdir(), `server-test-${Date.now()}.db`)
beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)
  // Initialize registry for tests (normally done in index.ts non-VITEST path)
  initExecutionServiceRegistry(db, new SSEService(), undefined)
})
afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../index"
import { WorkspaceService } from "../services/workspace"
import { getDb } from "../db/connection"
import { initExecutionServiceRegistry } from "../services/execution-service-registry"
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
        yield { type: 'text_delta', content: 'AI', messageId: msgId }
        yield { type: 'text_delta', content: ' response', messageId: msgId }
        yield { type: 'text_done', messageId: msgId }
        yield { type: 'message_stop', messageId: msgId }
        yield { type: 'result', sessionId: 'mock-session', tokens: { input: 1, output: 1 } }
      },
    })),
  }
})

describe("Server API", () => {
  let existingIds: Set<string>

  beforeAll(() => {
    const service = new WorkspaceService(new WorkspaceDAO(getDb()))
    existingIds = new Set(service.list().map(ws => ws.id))
  })

  afterAll(async () => {
    const service = new WorkspaceService(new WorkspaceDAO(getDb()))
    const currentIds = service.list().map(ws => ws.id)
    for (const id of currentIds) {
      if (!existingIds.has(id)) {
        await service.delete(id)
      }
    }
  })
  it("GET /api/workspaces returns empty list", async () => {
    const res = await app.request("/api/workspaces")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeInstanceOf(Array)
  })

  it("POST /api/workspaces creates workspace", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBeDefined()
    expect(data.name).toBe("test")
    expect(data.org).toBe("xzf")
    expect(data.created_at).toBeDefined()
  })

  it("GET /api/workspaces/:id returns created workspace", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "fetch-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const created = await createRes.json()

    const getRes = await app.request(`/api/workspaces/${created.id}`)
    expect(getRes.status).toBe(200)
    const fetched = await getRes.json()
    expect(fetched.id).toBe(created.id)
    expect(fetched.name).toBe("fetch-test")
  })

  it("GET /api/workspaces/:id returns 404 for missing", async () => {
    const res = await app.request("/api/workspaces/nonexistent-id")
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe("not found")
  })

  it("PUT /api/workspaces/:id updates workspace", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "update-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const created = await createRes.json()

    const updateRes = await app.request(`/api/workspaces/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "updated-name" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(updateRes.status).toBe(200)
    const updated = await updateRes.json()
    expect(updated.name).toBe("updated-name")
  })

  it("DELETE /api/workspaces/:id deletes workspace", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "delete-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const created = await createRes.json()

    const deleteRes = await app.request(`/api/workspaces/${created.id}`, {
      method: "DELETE",
    })
    expect(deleteRes.status).toBe(200)

    const getRes = await app.request(`/api/workspaces/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it("GET /api/orgs returns org list", async () => {
    const res = await app.request("/api/orgs")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })

  it("POST /api/workspaces rejects invalid org", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", org: "nonexistent" }),
    })
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain("not found")
  })

  it("GET /api/dashboard/stats returns stats", async () => {
    const res = await app.request("/api/dashboard/stats")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total_workspaces).toBeDefined()
    expect(data.total_workflows).toBeDefined()
    expect(data.total_executions).toBeDefined()
    expect(data.running_executions).toBeDefined()
  })

  it("GET /api/dashboard/queue returns running executions", async () => {
    const res = await app.request("/api/dashboard/queue")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeInstanceOf(Array)
  })

  it("GET /api/workspaces/:id/workflows returns empty list", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "wf-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const created = await createRes.json()

    const res = await app.request(`/api/workspaces/${created.id}/workflows`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeInstanceOf(Array)
  })

  it("POST /api/workspaces/:id/executions creates execution", async () => {
    const createWs = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "exec-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const ws = await createWs.json()

    const res = await app.request(`/api/workspaces/${ws.id}/executions`, {
      method: "POST",
      body: JSON.stringify({ workflowName: "test-workflow" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBeDefined()
    expect(data.workflow_name).toBe("test-workflow")
    expect(data.status).toBe("pending")
  })

  it("POST /api/workspaces/:id/executions/:eid/retry returns 400 for non-failed execution", async () => {
    const createWs = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "retry-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const ws = await createWs.json()

    const createRes = await app.request(`/api/workspaces/${ws.id}/executions`, {
      method: "POST",
      body: JSON.stringify({ workflowName: "retry-test" }),
      headers: { "Content-Type": "application/json" },
    })
    const created = await createRes.json()

    // Retry on pending execution should fail with 400
    const retryRes = await app.request(`/api/workspaces/${ws.id}/executions/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ failedNodeId: "node-1" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(retryRes.status).toBe(400)
  })

  it("GET /api/workspaces/:id/executions/:eid/logs returns SSE stream", async () => {
    const createWs = await app.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "sse-test", org: "xzf" }),
      headers: { "Content-Type": "application/json" },
    })
    const ws = await createWs.json()

    const createRes = await app.request(`/api/workspaces/${ws.id}/executions`, {
      method: "POST",
      body: JSON.stringify({ workflowName: "sse-test" }),
      headers: { "Content-Type": "application/json" },
    })
    const created = await createRes.json()

    const logsRes = await app.request(`/api/workspaces/${ws.id}/executions/${created.id}/logs`)
    expect(logsRes.status).toBe(200)
    expect(logsRes.headers.get("content-type")).toContain("text/event-stream")
  })

  it("POST /api/workspaces/:id/chat/sessions creates chat session", async () => {
    const res = await app.request("/api/workspaces/ws-chat/chat/sessions", {
      method: "POST",
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBeDefined()
    expect(data.workspaceId).toBe("ws-chat")
    expect(data.messages).toBeInstanceOf(Array)
  })

  it("GET /api/workspaces/:id/chat/sessions lists sessions", async () => {
    const res = await app.request("/api/workspaces/ws-chat/chat/sessions")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeInstanceOf(Array)
  })

  it("POST /api/workspaces/:id/chat/sessions/:sid/messages sends message", async () => {
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    const ws = wsService.create({ name: "ws-msg-test", org: "xzf", path: "/tmp/ws-msg-test" })

    const sessionRes = await app.request(`/api/workspaces/${ws.id}/chat/sessions`, {
      method: "POST",
    })
    const session = await sessionRes.json()

    const msgRes = await app.request(`/api/workspaces/${ws.id}/chat/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(msgRes.status).toBe(200)
    expect(msgRes.headers.get("content-type")).toContain("text/event-stream")

    // Parse SSE stream to extract chunk data
    const text = await msgRes.text()
    const lines = text.split("\n")
    const chunks: Array<{ event: string; data: unknown }> = []
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        chunks.push({ event: line.slice(7), data: null })
      } else if (line.startsWith("data: ")) {
        const last = chunks[chunks.length - 1]
        if (last) last.data = JSON.parse(line.slice(6))
      }
    }

    const textChunks = chunks.filter(c => c.event === 'text_delta')
    expect(textChunks.length).toBeGreaterThan(0)
  })
})