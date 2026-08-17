import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Task, TaskStatus } from "@octopus/shared"

// Mock server-config so URLs are deterministic.
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  readyTask,
  abortTask,
  updateSpecField,
  type TaskDetail,
} from "../tasks-api"

// ── Test fixtures ────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    org: "default",
    name: overrides.id,
    status: "draft",
    task_spec: { goal: "g", ac: ["a"], resources: [], authoring_resources: [] },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 1,
    source_chat_session_id: null,
    deleted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    completed_at: null,
    ...overrides,
  } as Task
}

function makeDetail(overrides: Partial<TaskDetail> & { id: string }): TaskDetail {
  const { children, ...taskOverrides } = overrides
  return {
    ...makeTask(taskOverrides),
    children: children ?? [],
  }
}

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number; json?: () => Promise<unknown> } = {}) {
  const ok = init.ok ?? true
  const status = init.status ?? (ok ? 200 : 500)
  const json = init.json ?? (async () => body)
  ;(globalThis.fetch as unknown as { mockResolvedValueOnce: (v: unknown) => unknown }).mockResolvedValueOnce({
    ok,
    status,
    json,
  } as unknown as Response)
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// ── listTasks ───────────────────────────────────────────────────────

describe("listTasks", () => {
  it("GETs /api/tasks and returns items[]", async () => {
    mockFetchOnce({ items: [makeTask({ id: "t1" }), makeTask({ id: "t2" })] })

    const result = await listTasks()

    expect(fetch).toHaveBeenCalledOnce()
    const call = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls[0]
    const [url, init] = call
    expect(url).toBe("http://localhost:3001/api/tasks")
    // GET uses single-arg fetch(url) — no init object — default method is GET.
    expect(init?.method ?? "GET").toBe("GET")
    expect(result.items.map((t) => t.id)).toEqual(["t1", "t2"])
  })

  it("forwards status + org as query params", async () => {
    mockFetchOnce({ items: [] })

    await listTasks({ status: "draft", org: "acme" })

    const url = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0][0] as string
    expect(url).toContain("status=draft")
    expect(url).toContain("org=acme")
  })

  it("omits undefined params", async () => {
    mockFetchOnce({ items: [] })

    await listTasks({})

    const url = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0][0] as string
    expect(url).not.toContain("status=")
    expect(url).not.toContain("org=")
  })

  it("throws on HTTP error with body.error message", async () => {
    mockFetchOnce({ error: "Task not found" }, { ok: false, status: 404 })

    await expect(listTasks()).rejects.toThrow("Task not found")
  })

  it("throws fallback message when body has no error field", async () => {
    mockFetchOnce({}, { ok: false, status: 500 })

    await expect(listTasks()).rejects.toThrow("HTTP 500")
  })
})

// ── getTask ──────────────────────────────────────────────────────────

describe("getTask", () => {
  it("GETs /api/tasks/:id and returns TaskDetail (with children)", async () => {
    const detail = makeDetail({
      id: "t1",
      children: [
        { schedule_id: "s1", name: "子1", status: "running", origin_role: "subunit", workflow_ref: "wf-a" },
      ],
    })
    mockFetchOnce(detail)

    const result = await getTask("t1")

    expect(fetch).toHaveBeenCalledOnce()
    const [url] = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks/t1")
    expect(result.id).toBe("t1")
    expect(result.children).toBeDefined()
    expect(result.children!).toHaveLength(1)
    expect(result.children![0].schedule_id).toBe("s1")
    expect(result.children![0].origin_role).toBe("subunit")
  })
})

// ── createTask ──────────────────────────────────────────────────────

describe("createTask", () => {
  it("POSTs /api/tasks with body and returns the created Task", async () => {
    const created = makeTask({ id: "new", name: "My task" })
    mockFetchOnce(created)

    const result = await createTask({ org: "acme", name: "My task", source_chat_session_id: "sess-1" })

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body as string)).toMatchObject({
      org: "acme",
      name: "My task",
      source_chat_session_id: "sess-1",
    })
    expect(result.id).toBe("new")
  })
})

// ── updateTask ([save draft] — PUT with If-Match) ────────────────────

describe("updateTask", () => {
  it("PUTs /api/tasks/:id with If-Match header + JSON body", async () => {
    const updated = makeTask({ id: "t1", version: 2, name: "renamed" })
    mockFetchOnce(updated)

    const result = await updateTask(
      "t1",
      {
        name: "renamed",
        task_spec: { goal: "g2", ac: ["a"], resources: [], authoring_resources: [] },
        resources: [{ type: "skill", name: "octo-x" }],
      },
      1,
    )

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks/t1")
    expect(init.method).toBe("PUT")
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "If-Match": "1",
    })
    const body = JSON.parse(init.body as string)
    expect(body.name).toBe("renamed")
    expect(body.task_spec.goal).toBe("g2")
    expect(body.resources).toEqual([{ type: "skill", name: "octo-x" }])
    expect(result.version).toBe(2)
  })

  it("throws 409 message on version conflict", async () => {
    mockFetchOnce({ error: "Task version conflict (stale write)" }, { ok: false, status: 409 })

    await expect(updateTask("t1", { name: "x" }, 1)).rejects.toThrow("Task version conflict")
  })

  it("throws 409 message on status conflict (frozen spec)", async () => {
    mockFetchOnce({ error: "Cannot edit task in status 'running'" }, { ok: false, status: 409 })

    await expect(updateTask("t1", { name: "x" }, 1)).rejects.toThrow("Cannot edit task in status 'running'")
  })
})

// ── deleteTask ──────────────────────────────────────────────────────

describe("deleteTask", () => {
  it("DELETEs /api/tasks/:id and returns {ok:true}", async () => {
    mockFetchOnce({ ok: true })

    const result = await deleteTask("t1")

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks/t1")
    expect(init.method).toBe("DELETE")
    expect(result).toEqual({ ok: true })
  })
})

// ── readyTask (dispatch seam — draft→ready) ─────────────────────────

describe("readyTask", () => {
  it("POSTs /api/tasks/:id/ready and returns the readied Task", async () => {
    const readied = makeTask({ id: "t1", status: "ready" })
    mockFetchOnce(readied)

    const result = await readyTask("t1")

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks/t1/ready")
    expect(init.method).toBe("POST")
    expect(result.status).toBe("ready")
  })
})

// ── abortTask (running→aborted + ws cleanup) ────────────────────────

describe("abortTask", () => {
  it("POSTs /api/tasks/:id/abort and returns the aborted Task", async () => {
    const aborted = makeTask({ id: "t1", status: "aborted" })
    mockFetchOnce(aborted)

    const result = await abortTask("t1")

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks/t1/abort")
    expect(init.method).toBe("POST")
    expect(result.status).toBe("aborted")
  })
})

// ── updateSpecField (agent tool endpoint) ───────────────────────────

describe("updateSpecField", () => {
  it("POSTs /api/tasks/:id/spec-field with {field,value} and returns {version}", async () => {
    mockFetchOnce({ version: 3 })

    const result = await updateSpecField("t1", "goal", "new goal text")

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/tasks/t1/spec-field")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual({ field: "goal", value: "new goal text" })
    expect(result).toEqual({ version: 3 })
  })
})

// ── unused import guard (keeps TaskStatus import honest) ────────────

describe("type re-exports", () => {
  it("Task type is assignable from fixture (compile-time check via runtime shape)", () => {
    const t: Task = makeTask({ id: "x" })
    const s: TaskStatus = t.status
    expect(s).toBe("draft")
  })
})
