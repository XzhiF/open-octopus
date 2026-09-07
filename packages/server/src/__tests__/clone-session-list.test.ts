// packages/server/src/__tests__/clone-session-list.test.ts
//
// GET /api/clones/:name/sessions — task-owned session filter.
//
// A task draft's chat session (tasks.source_chat_session_id) belongs to the
// task modal, not the clone chatbot. Unfiltered, opening e.g. task-author
// auto-loads the newest unrelated task's conversation. Verifies:
//   1. task-bound sessions are excluded from the list;
//   2. direct (unbound) clone sessions still list normally;
//   3. soft-deleted tasks release their sessions back to the clone pool;
//   4. the DAO batch lookup returns links for non-deleted rows only.
//
// Anti-fake-run: real better-sqlite3 + applySchema, real DAOs wired into the
// route, Hono app.request, E2E_CSL_ prefix, SQL assertions.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { createCloneSessionRoutes } from "../routes/clone"

vi.mock("../services/agent/clone-resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/agent/clone-resolver")>()
  return {
    ...real,
    resolveCloneInfo: (name: string) =>
      name === "task-author"
        ? {
            name,
            display_name: "Task Author",
            type: "built-in" as const,
            persona: "# task-author",
            skills: [],
            memory_scope: "shared" as const,
          }
        : null,
  }
})

const ORG = "e2e-csl"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

function insertTask(db: Database.Database, id: string, sessionId: string, deletedAt: string | null = null): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'draft', ?, '{}', '[]', '[]', '[]', '[]', NULL, 1, ?, ?, ?, NULL)
  `).run(id, ORG, `E2E_CSL ${id}`, sessionId, deletedAt, now, now)
}

async function createSession(app: Hono): Promise<string> {
  const res = await app.request("/api/clones/task-author/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function listSessionIds(app: Hono): Promise<string[]> {
  const res = await app.request("/api/clones/task-author/sessions?limit=50", {
    headers: { "X-Octopus-Org": ORG },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { sessions: { id: string }[] }
  return body.sessions.map((s) => s.id)
}

describe("clone session list — task-owned session filter", () => {
  let db: Database.Database
  let app: Hono
  let taskDAO: TaskDAO

  beforeAll(() => {
    process.env.OCTOPUS_HOME = `/tmp/octopus-csl-test-${Date.now()}`
    db = newDb()
    const sessionDAO = new AgentSessionDAO(db)
    taskDAO = new TaskDAO(db)
    app = new Hono()
    app.route("/api/clones", createCloneSessionRoutes({ sessionDAO, taskDAO }))
  })

  afterAll(() => {
    db.close()
    delete process.env.OCTOPUS_HOME
  })

  it("excludes task-bound sessions, keeps direct sessions, releases soft-deleted ones", async () => {
    const sTask = await createSession(app)
    const sDirect = await createSession(app)
    const sDeleted = await createSession(app)
    insertTask(db, "e2e-csl-t1", sTask)
    insertTask(db, "e2e-csl-t2", sDeleted, new Date().toISOString())

    const listed = await listSessionIds(app)
    expect(listed).toContain(sDirect)
    expect(listed).not.toContain(sTask)
    // soft-deleted task ⇒ its session returns to the clone pool
    expect(listed).toContain(sDeleted)

    // DAO batch lookup mirrors the same semantics
    const links = taskDAO.getLinksBySourceChatSessions([sTask, sDirect, sDeleted])
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ session_id: sTask, task_id: "e2e-csl-t1" })
  })

  it("empty session id list returns no links (no SQL with empty IN)", () => {
    expect(taskDAO.getLinksBySourceChatSessions([])).toEqual([])
  })
})
