// packages/server/src/__tests__/chat-event-bridge-task-cards.test.ts
//
// M2-1/M2-2 — task status → transcript cards + wake policy.
// The bridge is the deterministic half of "the main chat always knows".
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import {
  getChatEventBridge,
  resetChatEventBridgeForTests,
} from "../services/activity/chat-event-bridge"
import { TaskLifecycleService } from "../services/tasks/task-lifecycle-service"
import type { SSEService } from "../services/sse"

const ORG = "e2e-bridge-cards"
const NOW = "2026-10-28T11:00:00.000Z"

let db: Database.Database
let emit: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function insertSession(id: string, clone: string | null): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(id, ORG, "T", clone, clone ? "clone_direct" : "main", NOW, NOW)
}

function insertTask(id: string, sessionId: string, workspaceId: string | null = "ws-1"): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at, workspace_id)
    VALUES (?, ?, ?, 'draft', ?, '{"format":"v4"}', ?, ?, ?)
  `).run(id, ORG, `任务 ${id}`, sessionId, NOW, NOW, workspaceId)
}

function insertExec(taskId: string, id: string): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, created_at, updated_at)
    VALUES (?,'ws-1',?, 'built-in/matt-spec-dev','dev','running',?,1,1,'{}','{}',?,?,?)
  `).run(id, ORG, taskId, NOW, NOW, NOW)
}

function cards(sessionId: string): Array<{ content: string; meta: Record<string, unknown> }> {
  return db.prepare("SELECT content, metadata FROM messages WHERE session_id = ? ORDER BY created_at, rowid")
    .all(sessionId)
    .map((r) => {
      const row = r as { content: string; metadata: string }
      return { content: row.content, meta: JSON.parse(row.metadata) as Record<string, unknown> }
    })
}

function activity(sessionId: string, index = 0): Record<string, unknown> {
  return cards(sessionId)[index].meta.activity as Record<string, unknown>
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`
    INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at)
    VALUES ('ws-1', 'ws', ?, 'C:/tmp/ws-1', ?, ?)
  `).run(ORG, NOW, NOW)
  insertSession("s-main", null)
  insertSession("s-clone", "task-author")
  insertTask("t-thread", "s-main")
  insertTask("t-legacy", "s-clone")
  insertExec("t-thread", "e-thread")
  insertExec("t-legacy", "e-legacy")
})

afterAll(() => db.close())

beforeEach(() => {
  resetChatEventBridgeForTests()
  db.prepare("DELETE FROM messages").run()
  emit = vi.fn()
  fetchMock = vi.fn(async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }))
  vi.stubGlobal("fetch", fetchMock)
  delete process.env.OCTOPUS_CHAT_AUTO_WAKE
  const bridge = getChatEventBridge()
  bridge.attach(db)
  bridge.attachSse({ emit } as unknown as SSEService)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OCTOPUS_CHAT_AUTO_WAKE
})

describe("task status cards", () => {
  it("thread: every transition is one silent card, low-signal never wakes", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "ready" } })
    let rows = cards("s-main")
    expect(rows).toHaveLength(1)
    expect(rows[0].meta.displayType).toBe("event")
    expect(activity("s-main").status).toBe("ready")
    expect((activity("s-main").actions as Array<{ id: string }>).map((a) => a.id)).toContain("trigger")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalled() // open chat is told to reload

    // Repeated frame = same status → no second card.
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "ready" } })
    expect(cards("s-main")).toHaveLength(1)

    // A new episode of the same status (next phase) still cards.
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "running" } })
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "awaiting_review" } })
    rows = cards("s-main")
    expect(rows).toHaveLength(3)
    expect(activity("s-main", 2).status).toBe("awaiting_review")
    expect((activity("s-main", 2).actions as Array<{ id: string }>).map((a) => a.id)).toEqual([
      "open_acceptance",
      "open_changes",
    ])
  })

  it("thread: awaiting_review wakes with ephemeral=true (card is not duplicated)", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "awaiting_review" } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body)) as Record<string, unknown>
    expect(body.ephemeral).toBe(true)
    expect((body.activity as Record<string, unknown>).status).toBe("awaiting_review")
    expect(cards("s-main")).toHaveLength(1)
  })

  it("legacy clone thread: no card, wake keeps the old persisted-message path", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t-legacy", status: "awaiting_review" } })
    expect(cards("s-clone")).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body)) as Record<string, unknown>
    expect(body.ephemeral).toBeUndefined()
  })

  it("paused is a card with resume/abort actions and no wake", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "paused" } })
    expect(cards("s-main")).toHaveLength(1)
    expect((activity("s-main").actions as Array<{ id: string }>).map((a) => a.id)).toEqual([
      "resume",
      "open_run",
      "abort",
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("OCTOPUS_CHAT_AUTO_WAKE=0 still cards (deterministic layer is not disabled)", () => {
    process.env.OCTOPUS_CHAT_AUTO_WAKE = "0"
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t-thread", status: "done" } })
    expect(cards("s-main")).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("task round execution binding", () => {
  it("binds a round's execution to the main thread; legacy clone threads stay unbound", () => {
    const svc = new TaskLifecycleService({
      db,
      sse: { emit: vi.fn() } as unknown as SSEService,
    })
    const spy = vi.spyOn(getChatEventBridge(), "bindExecution")
    ;(svc as unknown as { armTask: () => string; launchQueued: () => void }).armTask = () => "e-thread"
    ;(svc as unknown as { launchQueued: () => void }).launchQueued = () => {}
    svc.armAndLaunch("t-thread")
    expect(spy).toHaveBeenCalledWith("e-thread", expect.objectContaining({
      sessionId: "s-main",
      workspaceId: "ws-1",
    }))

    spy.mockClear()
    ;(svc as unknown as { armTask: () => string }).armTask = () => "e-legacy"
    svc.armAndLaunch("t-legacy")
    expect(spy).not.toHaveBeenCalled()
  })
})
