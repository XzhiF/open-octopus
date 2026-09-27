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
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

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

let pg: PgFixture | null = null

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

// P1 B2 配方 §5：PG tasks.source_chat_session_id 有 FK → PG sessions 需要父行。
async function seedPgSession(id: string, org: string, title: string) {
  const now = new Date().toISOString()
  await pg!.sql`
    INSERT INTO sessions (id, org, title, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (${id}, ${org}, ${title}, 'main', true, false, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING`
}

async function readTasksBySession(sessionId: string) {
  return (await pg!.sql`
    SELECT id, status, source_chat_session_id, name, version::int AS version,
      task_spec #>> '{}' AS task_spec,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM tasks WHERE source_chat_session_id = ${sessionId}`)[0]
}

async function readTaskNameById(id: string): Promise<{ name: string }> {
  return (await pg!.sql`SELECT name FROM tasks WHERE id = ${id}`)[0]
}

describePg("04: task-author autosave seam + scope_id writer (integration)", () => {
  let db: Database.Database
  let app: Hono
  let sessionDAO: AgentSessionDAO
  let taskDAO: TaskDAO

  beforeAll(async () => {
    // Hermetic OCTOPUS_HOME so paths.getBuiltInCloneDir points to an empty
    // temp dir (resolveCloneDefFromFs falls through to mocked info.persona).
    process.env.OCTOPUS_HOME = `/tmp/octopus-test-${Date.now()}`
    // P1 B3 双引擎：tasks 与 sessions/messages 都落这座注册 PG 库 —— autosave seam
    // 写的任务行 source_chat_session_id FK 直接对 PG sessions（配方 §5 已同库化）。
    pg = await setupRegisteredPgSchema()
    db = newDb()
    sessionDAO = new AgentSessionDAO(pg.sql)
    taskDAO = new TaskDAO(pg.sql)
    app = new Hono()
    app.route("/api/clones", createCloneSessionRoutes({ sessionDAO, taskDAO }))
  })

  afterAll(async () => {
    await pg!.close()
    pg = null
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
    await seedPgSession(session.id, ORG, session.title)

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
    const taskRow = (await readTasksBySession(session.id)) as any
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
    // P1 B3: sessions 已迁 PG —— 直读这座随机库。
    const sessionRow = (await pg!.sql`
      SELECT scope_id FROM sessions WHERE id = ${session.id}`)[0] as { scope_id: string | null }
    expect(sessionRow.scope_id).toBe(taskRow.id)
  })

  // ── AC2: second turn → updated_at bumped, name PRESERVED (user-owned) ──

  it("AC2: second turn bumps updated_at but preserves the user-owned task name (no clobber)", async () => {
    // Fresh session for isolation
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    const session = (await createRes.json()) as { id: string }
    await seedPgSession(session.id, ORG, "e2e")

    // First turn — establishes the task row
    const r1 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD first message here" }),
    })
    await r1.text()

    const beforeRow = (await readTasksBySession(session.id)) as any

    // Simulate the user renaming the task header. In the product this goes
    // through PUT /api/tasks/:id {name} which ALSO syncs the bound session
    // title (TasksService.updateTask) — replicate both here so the two stores
    // stay equal, exactly as the header rename does.
    const renamedTitle = "E2E_TD user-renamed task title"
    // P1 B2: user-rename seam writes PG tasks.
    await pg!.sql`UPDATE tasks SET name = ${renamedTitle} WHERE id = ${beforeRow.id}`
    // P1 B3: sessions 已迁 PG —— 标题同步也落这座库。
    await pg!.sql`UPDATE sessions SET title = ${renamedTitle} WHERE id = ${session.id}`

    // Ensure updated_at advances (ISO millisecond precision)
    await new Promise((r) => setTimeout(r, 5))

    // Second turn
    const r2 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD second message" }),
    })
    await r2.text()

    const afterRow = (await readTasksBySession(session.id)) as any

    // SG8: version UNCHANGED (no bump)
    expect(afterRow.version).toBe(beforeRow.version) // still 1
    // SG8: task_spec UNCHANGED (autosave must not touch it)
    expect(afterRow.task_spec).toBe(beforeRow.task_spec)
    expect(afterRow.task_spec).toBe("{}")
    // BUGFIX 2026-08-21: the manual rename survives the autosave — the task
    // name is user-owned once the draft row exists, so autosave no longer
    // overwrites it with the session title.
    expect(afterRow.name).toBe(renamedTitle)
    // updated_at bumped (heartbeat)
    expect(afterRow.updated_at > beforeRow.updated_at).toBe(true)
  })

  // ── AC3: a session-title change alone does NOT leak into the task name ──

  it("AC3: a sidebar session-title change does NOT overwrite the task name", async () => {
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    const session = (await createRes.json()) as { id: string }
    await seedPgSession(session.id, ORG, "e2e")

    // Turn 1 — establishes the task row with the auto-title.
    const r1 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD establish title" }),
    })
    await r1.text()
    const before = (await readTasksBySession(session.id)) as { name: string }
    // Auto-title = first 20 chars of the first message (truncated).
    expect(before.name).toBe("E2E_TD establish tit")

    // Session renamed in the sidebar (no task sync — this is NOT a header
    // rename). The autosave must not propagate it into the task name.
    // P1 B3: sessions 已迁 PG。
    await pg!.sql`UPDATE sessions SET title = ${"E2E_TD sidebar-only rename"} WHERE id = ${session.id}`

    await new Promise((r) => setTimeout(r, 5))
    const r2 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD second" }),
    })
    await r2.text()

    const after = (await readTasksBySession(session.id)) as { name: string }
    // Task title wins — the session rename stays in the chat sidebar only.
    expect(after.name).toBe(before.name)
  })

  // ── Gate: turn 1 of a task-bound session does not clobber a user-set name ──

  it("gate: turn 1 of a task-bound session preserves the POST-created name", async () => {
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    const session = (await createRes.json()) as { id: string }
    await seedPgSession(session.id, ORG, "e2e")

    // Pre-bind a task the way POST /api/tasks does (source_chat_session_id).
    const taskId = "e2e-td-prebound-task"
    const now = new Date().toISOString()
    await taskDAO.insert({
      id: taskId,
      org: ORG,
      name: "E2E_TD manual POST title",
      status: "draft",
      source_chat_session_id: session.id,
      created_at: now,
      updated_at: now,
    })

    // First chat turn on the bound session.
    const r1 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD first message here" }),
    })
    await r1.text()

    // The POST-created (user-set) name is preserved — autosave's existing
    // branch only adopts the session title while the name is still the
    // default, never a user-set name.
    const row = (await readTaskNameById(taskId))
    expect(row.name).toBe("E2E_TD manual POST title")

    // The auto-title block DID fire (title was still the placeholder): the
    // session title is derived from the first message for the sidebar. The
    // derived title must NOT leak into the user-set task name (asserted
    // above) — the two stores are allowed to diverge here.
    // P1 B3: sessions 已迁 PG —— 标题直读这座库。
    const s = (await pg!.sql`SELECT title FROM sessions WHERE id = ${session.id}`)[0] as {
      title: string
    }
    expect(s.title).toBe("E2E_TD first message")
  })

  // ── Refinement: default-name draft adopts the smart title after first chat ──

  it("refinement: a pre-bound task with the DEFAULT name adopts the smart title on first chat", async () => {
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    const session = (await createRes.json()) as { id: string }
    await seedPgSession(session.id, ORG, "e2e")

    // Pre-bind a draft the way POST /api/tasks does when the caller sends no
    // name → DEFAULT_TASK_NAME ("Untitled task").
    const taskId = "e2e-td-default-name-task"
    const now = new Date().toISOString()
    await taskDAO.insert({
      id: taskId,
      org: ORG,
      name: "Untitled task",
      status: "draft",
      source_chat_session_id: session.id,
      created_at: now,
      updated_at: now,
    })

    // First chat turn on the bound session.
    const r1 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD 给 workflow 执行增加监控 context 功能" }),
    })
    await r1.text()

    // The default name is NOT user-owned → autosave adopts the smart session
    // title (first 20 chars of the first message).
    const row = (await readTaskNameById(taskId))
    const expectedTitle =
      "E2E_TD 给 workflow 执行增加监控 context 功能".slice(0, 20).replace(/\n/g, " ").trim()
    expect(row.name).toBe(expectedTitle)
    expect(row.name).not.toBe("Untitled task")

    // Second turn: the name is now user-adopted (no longer the default) and
    // must be stable — no further rewrites from the session title.
    await new Promise((r) => setTimeout(r, 5))
    const r2 = await app.request(`/api/clones/task-author/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD 第二条消息完全不同" }),
    })
    await r2.text()
    const after = (await readTaskNameById(taskId))
    expect(after.name).toBe(expectedTitle)
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
    await seedPgSession(session.id, ORG, "e2e")

    const r3 = await app.request(`/api/clones/workspace/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ message: "E2E_TD unrelated clone chat" }),
    })
    await r3.text()

    // No task row should exist for this session (cloneName !== 'task-author')
    const taskRow = (await readTasksBySession(session.id))
    expect(taskRow).toBeUndefined()
  })
})
