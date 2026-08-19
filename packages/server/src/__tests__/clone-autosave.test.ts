// packages/server/src/__tests__/clone-autosave.test.ts
//
// 04 — task-author autosave seam + scope_id writer (AC1/AC2/AC3, SG3/SG8).
//
// Verifies via the route seam (POST /api/clones/task-author/sessions/:id/chat):
//   AC1: first task-author turn → tasks row created (status=draft,
//        source_chat_session_id, name=auto from first user msg) +
//        sessions.scope_id=task.id (SG3, implicit autosave path).
//   AC2: second turn → name+updated_at re-written; version UNCHANGED;
//        task_spec/resources untouched (SG8).
//   Gate: non-task-author clone chat does NOT create a task row
//        (cloneName === 'task-author' gate, v2-D6).
//
// Anti-fake-run: real better-sqlite3 + applySchema (R1/R3/R5), real
// AgentSessionDAO + TaskDAO wired into the route, Hono app.request (R3),
// data prefix E2E_TD_ (R7), assert SQL (R4). Only the LLM provider
// (CloneRuntime) + clone-resolver are mocked — the route, session DAO,
// task DAO, autosave seam, and auto-title block all run for real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { createCloneSessionRoutes } from "../routes/clone"

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock CloneRuntime so chat yields a deterministic text reply + result chunk
// without hitting a real LLM. Satisfies the route's usage:
//   const runtime = new CloneRuntime(cloneDef, org)
//   const cwd = runtime.getDefaultCwd()
//   for await (const chunk of runtime.chat(message, sessionId, providerSessionId, cwd)) { ... }
const FAKE_REPLY = "OK, I'll help you build that."
vi.mock("../services/agent/clone-runtime", () => ({
  CloneRuntime: class {
    constructor(_cloneDef: unknown, _org: string) {}
    getDefaultCwd(): string {
      return "/tmp/fake-cwd"
    }
    async *chat() {
      yield { type: "text_delta", content: FAKE_REPLY, messageId: "fake-msg-id" }
      yield { type: "result", sessionId: "fake-provider-session" }
    }
  },
}))

// Mock clone-resolver so resolveCloneInfo returns built-in clone info without
// filesystem setup. resolveCloneDefFromFs falls through to info.persona when
// fs.existsSync(personaPath) is false (OCTOPUS_HOME points to an empty temp dir).
vi.mock("../services/agent/clone-resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/agent/clone-resolver")>()
  return {
    ...real,
    resolveCloneInfo: (name: string) => {
      if (name !== "task-author" && name !== "workspace") return null
      return {
        name,
        display_name: name === "task-author" ? "Task Author" : "Workspace",
        type: "built-in" as const,
        persona: `# ${name}\n\nFake persona for test.`,
        skills: [],
        memory_scope: "shared" as const,
      }
    },
  }
})

const ORG = "e2e-td-04"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

describe("04: task-author autosave seam + scope_id writer (integration)", () => {
  let db: Database.Database
  let app: Hono
  let sessionDAO: AgentSessionDAO
  let taskDAO: TaskDAO

  beforeAll(() => {
    // Hermetic OCTOPUS_HOME so paths.getBuiltInCloneDir points to an empty
    // temp dir (resolveCloneDefFromFs falls through to mocked info.persona).
    process.env.OCTOPUS_HOME = `/tmp/octopus-test-${Date.now()}`
    db = newDb()
    sessionDAO = new AgentSessionDAO(db)
    taskDAO = new TaskDAO(db)
    app = new Hono()
    app.route("/api/clones", createCloneSessionRoutes({ sessionDAO, taskDAO }))
  })

  afterAll(() => {
    db.close()
    delete process.env.OCTOPUS_HOME
  })

  beforeEach(() => {
    // Reset between tests (none needed yet — each test uses unique sessions).
  })

  // ── AC1: first turn → tasks row created + scope_id linked ───────────────

  it("AC1: first task-author turn creates a draft task row + links session.scope_id (SG3)", async () => {
    // Create a task-author session (title defaults to 'task-author 会话')
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(201)
    const session = (await createRes.json()) as { id: string; title: string }
    expect(session.id).toBeTruthy()

    // First chat turn
    const firstMessage = "E2E_TD 早上好，帮我做一个后端服务"
    const chatRes = await app.request(
      `/api/clones/task-author/sessions/${session.id}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
        body: JSON.stringify({ message: firstMessage }),
      },
    )
    expect(chatRes.status).toBe(200)
    await chatRes.text() // drain SSE body so the seam runs

    // DB assert (R3/R4): tasks row created
    const taskRow = db
      .prepare(
        "SELECT id, status, source_chat_session_id, name, version, task_spec FROM tasks WHERE source_chat_session_id = ?",
      )
      .get(session.id) as {
        id: string
        status: string
        source_chat_session_id: string | null
        name: string
        version: number
        task_spec: string
      }
    expect(taskRow).toBeDefined()
    expect(taskRow.status).toBe("draft")
    expect(taskRow.source_chat_session_id).toBe(session.id)
    // Auto-title = first 20 chars of the first user message (the auto-title
    // block fires before the seam and sets the session title; the seam reads
    // the session title to name the task).
    const expectedTitle =
      firstMessage.slice(0, 20).replace(/\n/g, " ").trim() || "task-author 会话"
    expect(taskRow.name).toBe(expectedTitle)
    expect(taskRow.version).toBe(1)
    expect(taskRow.task_spec).toBe("{}") // SG8: autosave never touches task_spec

    // DB assert (SG3): sessions.scope_id = tasks.id
    const sessionRow = db
      .prepare("SELECT scope_id FROM sessions WHERE id = ?")
      .get(session.id) as { scope_id: string | null }
    expect(sessionRow.scope_id).toBe(taskRow.id)
  })

  // ── AC2: second turn → name+updated_at re-written, version unchanged ────

  it("AC2: second turn re-writes name+updated_at, keeps version at 1, leaves task_spec untouched (SG8)", async () => {
    // Fresh session for isolation
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    const session = (await createRes.json()) as { id: string }

    // First turn — establishes the task row
    const r1 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD first message here" }),
    })
    await r1.text()

    const beforeRow = db
      .prepare(
        "SELECT id, name, version, task_spec, updated_at FROM tasks WHERE source_chat_session_id = ?",
      )
      .get(session.id) as {
        id: string
        name: string
        version: number
        task_spec: string
        updated_at: string
      }

    // Simulate a user renaming the session between turns — proves the seam
    // re-derives the title from the session each turn (AC2 "title 更新").
    const renamedTitle = "E2E_TD user-renamed session title"
    db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(
      renamedTitle,
      session.id,
    )

    // Ensure updated_at advances (ISO millisecond precision)
    await new Promise((r) => setTimeout(r, 5))

    // Second turn
    const r2 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD second message" }),
    })
    await r2.text()

    const afterRow = db
      .prepare(
        "SELECT name, version, task_spec, updated_at FROM tasks WHERE source_chat_session_id = ?",
      )
      .get(session.id) as {
        name: string
        version: number
        task_spec: string
        updated_at: string
      }

    // SG8: version UNCHANGED (no bump)
    expect(afterRow.version).toBe(beforeRow.version) // still 1
    // SG8: task_spec UNCHANGED (autosave must not touch it)
    expect(afterRow.task_spec).toBe(beforeRow.task_spec)
    expect(afterRow.task_spec).toBe("{}")
    // AC2: title re-written to track the renamed session
    expect(afterRow.name).toBe(renamedTitle)
    // AC2: updated_at bumped (heartbeat)
    expect(afterRow.updated_at > beforeRow.updated_at).toBe(true)
  })

  // ── Gate: non-task-author clones do NOT trigger the seam ────────────────

  it("gate: non-task-author clone (workspace) chat does NOT create a task row", async () => {
    const createRes = await app.request("/api/clones/workspace/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(201)
    const session = (await createRes.json()) as { id: string }

    const r3 = await app.request(`/api/clones/workspace/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD unrelated clone chat" }),
    })
    await r3.text()

    // No task row should exist for this session (cloneName !== 'task-author')
    const taskRow = db
      .prepare("SELECT id FROM tasks WHERE source_chat_session_id = ?")
      .get(session.id)
    expect(taskRow).toBeUndefined()
  })
})
