// packages/server/src/__tests__/tasks-routes.test.ts
//
// 03 — tasks service + /api/tasks routes integration (AC1-AC4, SG2).
//
// Verifies:
//   AC1: /api/tasks CRUD + spec-field + ready + abort endpoints work
//   AC2: dispatch seam ready→建 schedules envelope (simple=1 primary; composite=1 coordinator)
//   AC3: ScheduleStatusListener: mock schedule transition → tasks.status mirror + task_status SSE
//   AC4: abort → aborted + child schedules cleaned
//
// Anti-fake-run: real better-sqlite3 DB + applySchema (R1/R3/R4/R5), Hono app
// request (R3 API↔DB), data prefix E2E_TD_ (R7), assert response+SQL (R4).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { ScheduleConfigDAO, ScheduleRunDAO, AgentSessionDAO, TaskDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskScheduleStatusListener } from "../services/scheduler/schedule-status-listener"
import {
  TASK_STATUS_EVENT,
  SPEC_FIELD_UPDATE_EVENT,
  type ScheduleStatus,
} from "@octopus/shared"

const ORG = "e2e-td-03"

type TaskStatusEvent = { task_id: string; status: string; schedule_id?: string }
type SpecFieldEvent = { task_id: string; field: string; value: unknown; version: number }

function makeSSECollector() {
  const sse = new SSEService()
  const taskEvents: TaskStatusEvent[] = []
  const specEvents: SpecFieldEvent[] = []
  sse.subscribe("taskpool", (e) => {
    if (e.event === TASK_STATUS_EVENT) {
      taskEvents.push(e.data as TaskStatusEvent)
    } else if (e.event === SPEC_FIELD_UPDATE_EVENT) {
      specEvents.push(e.data as SpecFieldEvent)
    }
  })
  return { sse, taskEvents, specEvents }
}

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

/** Insert a task row directly (bypass the service) to set up non-draft states. */
function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string
    name: string
    status: string
    task_spec: string
    project_ids: string
    skills: string
    version: number
  }> = {},
) {
  const id = overrides.id ?? `e2e-td-task-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', ?, ?, NULL, ?, NULL, ?, ?, NULL)
  `).run(
    id,
    ORG,
    overrides.name ?? "E2E_TD task",
    overrides.status ?? "draft",
    overrides.task_spec ?? JSON.stringify({ goal: "build X", ac: ["ac1"] }),
    overrides.skills ?? "[]",
    overrides.project_ids ?? "[]",
    overrides.version ?? 1,
    now,
    now,
  )
  return id
}

function readTaskStatus(db: Database.Database, id: string) {
  return db.prepare("SELECT status, version, completed_at FROM tasks WHERE id = ?").get(id) as
    { status: string; version: number; completed_at: string | null }
}

function readSchedulesByOrigin(db: Database.Database, taskId: string) {
  return db
    .prepare(
      "SELECT id, status, origin_type, origin_role FROM schedules WHERE origin_type = 'task' AND origin_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
    )
    .all(taskId) as Array<{
    id: string
    status: string
    origin_type: string
    origin_role: string | null
  }>
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

describe("03: /api/tasks routes + TasksService (integration)", () => {
  let db: Database.Database
  let app: Hono
  let sse: SSEService
  let taskEvents: TaskStatusEvent[]
  let specEvents: SpecFieldEvent[]
  let taskDAO: TaskDAO
  let scheduleDAO: ScheduleConfigDAO

  beforeAll(() => {
    db = newDb()
    const collector = makeSSECollector()
    sse = collector.sse
    taskEvents = collector.taskEvents
    specEvents = collector.specEvents
    taskDAO = new TaskDAO(db)
    scheduleDAO = new ScheduleConfigDAO(db)
    const service = new TasksService(db, sse, new AgentSessionDAO(db))
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    // Clear SSE collectors between tests
    taskEvents.length = 0
    specEvents.length = 0
  })

  // ── AC1: CRUD ────────────────────────────────────────────────────────

  it("POST /api/tasks creates a draft task (201 + DB row)", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD_crud" }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string; status: string; name: string; version: number }>(res)
    expect(task.status).toBe("draft")
    expect(task.name).toBe("E2E_TD_crud")
    expect(task.version).toBe(1)
    // DB assert (R3/R4)
    const row = readTaskStatus(db, task.id)
    expect(row.status).toBe("draft")
  })

  it("GET /api/tasks returns the kanban list", async () => {
    const res = await app.request(`/api/tasks?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await json<{ items: Array<{ status: string; org: string }> }>(res)
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.items.every((t) => t.org === ORG)).toBe(true)
  })

  it("GET /api/tasks/:id returns task detail with children[]", async () => {
    const id = insertTask(db, { name: "E2E_TD_detail" })
    const res = await app.request(`/api/tasks/${id}`)
    expect(res.status).toBe(200)
    const detail = await json<{ id: string; children: unknown[] }>(res)
    expect(detail.id).toBe(id)
    expect(Array.isArray(detail.children)).toBe(true)
  })

  it("PUT /api/tasks/:id updates with If-Match (save draft) + bumps version", async () => {
    const id = insertTask(db, { name: "E2E_TD_put" })
    const res = await app.request(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ name: "E2E_TD_put-renamed" }),
    })
    expect(res.status).toBe(200)
    const task = await json<{ name: string; version: number }>(res)
    expect(task.name).toBe("E2E_TD_put-renamed")
    expect(task.version).toBe(2)
  })

  it("PUT rejects stale If-Match with 409", async () => {
    const id = insertTask(db, { name: "E2E_TD_stale", version: 2 })
    const res = await app.request(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ name: "E2E_TD_stale-x" }),
    })
    expect(res.status).toBe(409)
  })

  it("DELETE /api/tasks/:id soft-deletes (discard draft)", async () => {
    const id = insertTask(db, { name: "E2E_TD_del" })
    const res = await app.request(`/api/tasks/${id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    // getById excludes soft-deleted
    expect(taskDAO.getById(id)).toBeNull()
  })

  // ── AC1: spec-field ─────────────────────────────────────────────────

  it("POST /:id/spec-field merges field + bumps version + emits spec_field_update SSE", async () => {
    const id = insertTask(db, { name: "E2E_TD_spec" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD new goal" }),
    })
    expect(res.status).toBe(200)
    const result = await json<{ version: number }>(res)
    expect(result.version).toBe(2)
    // DB assert: task_spec.goal updated (R3/R4)
    const spec = JSON.parse(
      (db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(id) as { task_spec: string }).task_spec,
    ) as { goal: string }
    expect(spec.goal).toBe("E2E_TD new goal")
    // SSE assert (R3)
    expect(specEvents).toContainEqual({
      task_id: id,
      field: "goal",
      value: "E2E_TD new goal",
      version: 2,
    })
  })

  it("POST /:id/spec-field rejects invalid field value with 400", async () => {
    const id = insertTask(db, { name: "E2E_TD_invalid" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /:id/spec-field maps skills→skills column, projects→project_ids", async () => {
    const id = insertTask(db, { name: "E2E_TD_skills" })
    // skills
    let res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "skills", value: ["octo-backend", "octo-frontend"] }),
    })
    expect(res.status).toBe(200)
    // projects
    res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "projects", value: ["proj-A", "proj-B"] }),
    })
    expect(res.status).toBe(200)
    // DB assert
    const row = db
      .prepare("SELECT skills, project_ids FROM tasks WHERE id = ?")
      .get(id) as { skills: string; project_ids: string }
    expect(JSON.parse(row.skills)).toEqual(["octo-backend", "octo-frontend"])
    expect(JSON.parse(row.project_ids)).toEqual(["proj-A", "proj-B"])
  })

  // ── AC2: dispatch seam (ready → schedules envelope) ─────────────────

  it("POST /:id/ready (simple) → draft→ready + 1 schedule (origin_type=task, role=primary, status=queued)", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_ready_simple",
      task_spec: JSON.stringify({ goal: "simple task", ac: ["ac1"] }),
      project_ids: JSON.stringify(["proj-A"]),
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    const task = await json<{ status: string }>(res)
    expect(task.status).toBe("ready")
    // DB assert: tasks.status=ready (R3/R4)
    expect(readTaskStatus(db, id).status).toBe("ready")
    // DB assert: 1 schedule envelope created (R2/R3)
    const schedules = readSchedulesByOrigin(db, id)
    expect(schedules.length).toBe(1)
    expect(schedules[0].origin_type).toBe("task")
    expect(schedules[0].origin_role).toBe("primary")
    // v39: enqueue PARKS the envelope (draft) — a manual POST /:id/trigger
    // arms it to 'queued'; the runner never auto-claims a ready task.
    expect(schedules[0].status).toBe("draft")
  })

  it("POST /:id/ready (composite, 2+ subunits) → 1 coordinator schedule (role=coordinator)", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_ready_composite",
      task_spec: JSON.stringify({
        goal: "composite task",
        ac: ["ac1"],
        subunits: [
          {
            name: "sub-A",
            workspace_spec: {
              org: ORG,
              branch_prefix: "suba",
              projects: [{ name: "proj-A", source_path: "", group: "" }],
            },
            workflow_ref: "built-in/sub-a.yaml",
            input_values: {},
            skills: [],
            resources: [],
          },
          {
            name: "sub-B",
            workspace_spec: {
              org: ORG,
              branch_prefix: "subb",
              projects: [{ name: "proj-B", source_path: "", group: "" }],
            },
            workflow_ref: "built-in/sub-b.yaml",
            input_values: {},
            skills: [],
            resources: [],
          },
        ],
      }),
      project_ids: JSON.stringify(["proj-A"]),
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    // DB assert: 1 coordinator schedule (subunit schedules are runtime-created by task_dispatch)
    const schedules = readSchedulesByOrigin(db, id)
    expect(schedules.length).toBe(1)
    expect(schedules[0].origin_role).toBe("coordinator")
    // v39: composite envelope is parked too (trigger arms it; see above).
    expect(schedules[0].status).toBe("draft")
  })

  it("POST /:id/ready rejects non-draft with 409", async () => {
    const id = insertTask(db, { name: "E2E_TD_ready_reject", status: "ready" })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
  })

  // ── AC4: abort ───────────────────────────────────────────────────────

  it("POST /:id/abort (running) → aborted + child schedules cleaned + task_status SSE", async () => {
    const id = insertTask(db, { name: "E2E_TD_abort", status: "running" })
    // Seed a child schedule (origin_type=task, claimed — in-flight)
    const childSchedId = `e2e-td-sched-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    scheduleDAO.insertSchedule({
      id: childSchedId,
      org: ORG,
      name: `E2E_TD_child-${childSchedId}`,
      cron_expression: null,
      timezone: "UTC",
      job_type: "workflow",
      config: "{}",
      status: "claimed",
      origin_type: "task",
      origin_id: id,
      origin_role: "primary",
      claimed_at: now,
      created_at: now,
      updated_at: now,
    } as any)
    const res = await app.request(`/api/tasks/${id}/abort`, { method: "POST" })
    expect(res.status).toBe(200)
    const task = await json<{ status: string }>(res)
    expect(task.status).toBe("aborted")
    // DB assert: task aborted (R3/R4)
    expect(readTaskStatus(db, id).status).toBe("aborted")
    // DB assert: child schedule aborted (G4 ws cleanup — status=aborted, claimed_at cleared)
    const childRow = db
      .prepare("SELECT status, claimed_at FROM schedules WHERE id = ?")
      .get(childSchedId) as { status: string; claimed_at: string | null }
    expect(childRow.status).toBe("aborted")
    expect(childRow.claimed_at).toBeNull()
    // SSE assert: task_status aborted (R3)
    expect(taskEvents).toContainEqual({ task_id: id, status: "aborted" })
  })

  it("POST /:id/abort rejects non-running/non-ready with 409", async () => {
    const id = insertTask(db, { name: "E2E_TD_abort_reject", status: "done" })
    const res = await app.request(`/api/tasks/${id}/abort`, { method: "POST" })
    expect(res.status).toBe(409)
  })

  // ── AC3: ScheduleStatusListener — mock schedule transition → tasks.status mirror + SSE ─

  it("listener: schedule queued → tasks.status running (mirror + task_status SSE)", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    // Seed a task in 'ready' (pre-dispatch) + a task-origin schedule
    const taskId = "e2e-td-listen-1"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen1", status: "ready" })
    // Simulate the scheduler claiming the schedule: listener.onScheduleTransition(queued)
    listener.onScheduleTransition({
      schedule_id: "sched-X",
      origin_type: "task",
      origin_id: taskId,
      status: "queued" as ScheduleStatus,
    })
    // DB assert: task flipped to running (mirror; no version bump)
    const row = readTaskStatus(listenerDb, taskId)
    expect(row.status).toBe("running")
    expect(row.version).toBe(1) // no version bump
    // SSE assert
    expect(lEvents).toContainEqual({
      task_id: taskId,
      status: "running",
      schedule_id: "sched-X",
      origin_type: "task",
    })
    listenerDb.close()
  })

  it("listener: schedule claimed → tasks running (idempotent — already running, no double SSE)", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    const taskId = "e2e-td-listen-2"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen2", status: "running" })
    // claimed → running (same) — idempotent fast-path
    listener.onScheduleTransition({
      schedule_id: "sched-Y",
      origin_type: "task",
      origin_id: taskId,
      status: "claimed" as ScheduleStatus,
    })
    expect(readTaskStatus(listenerDb, taskId).status).toBe("running")
    // No SSE emitted (idempotent)
    expect(lEvents.filter((e) => e.task_id === taskId)).toHaveLength(0)
    listenerDb.close()
  })

  it("listener: schedule done → tasks done (terminal, completed_at set)", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    const taskId = "e2e-td-listen-3"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen3", status: "running" })
    listener.onScheduleTransition({
      schedule_id: "sched-Z",
      origin_type: "task",
      origin_id: taskId,
      status: "done" as ScheduleStatus,
    })
    const row = readTaskStatus(listenerDb, taskId)
    expect(row.status).toBe("done")
    expect(row.completed_at).not.toBeNull()
    expect(lEvents).toContainEqual({
      task_id: taskId,
      status: "done",
      schedule_id: "sched-Z",
      origin_type: "task",
    })
    listenerDb.close()
  })

  it("listener: schedule failed → tasks failed (terminal, completed_at set)", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    const taskId = "e2e-td-listen-4"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen4", status: "running" })
    listener.onScheduleTransition({
      schedule_id: "sched-F",
      origin_type: "task",
      origin_id: taskId,
      status: "failed" as ScheduleStatus,
      error_summary: "boom",
    })
    expect(readTaskStatus(listenerDb, taskId).status).toBe("failed")
    expect(lEvents.find((e) => e.task_id === taskId && e.status === "failed")).toBeTruthy()
    listenerDb.close()
  })

  it("listener: schedule aborted → tasks aborted (terminal)", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    const taskId = "e2e-td-listen-5"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen5", status: "running" })
    listener.onScheduleTransition({
      schedule_id: "sched-A",
      origin_type: "task",
      origin_id: taskId,
      status: "aborted" as ScheduleStatus,
    })
    expect(readTaskStatus(listenerDb, taskId).status).toBe("aborted")
    expect(lEvents.find((e) => e.task_id === taskId && e.status === "aborted")).toBeTruthy()
    listenerDb.close()
  })

  it("listener: no-op for origin_type != 'task' (cron schedules don't touch tasks)", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    const taskId = "e2e-td-listen-cron"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen_cron", status: "ready" })
    listener.onScheduleTransition({
      schedule_id: "cron-sched",
      origin_type: "cron",
      origin_id: taskId, // would corrupt if the filter failed
      status: "done" as ScheduleStatus,
    })
    // No mirror — task stays ready
    expect(readTaskStatus(listenerDb, taskId).status).toBe("ready")
    expect(lEvents).toHaveLength(0)
    listenerDb.close()
  })

  it("listener: running transition (claimed→running during exec) → tasks running", () => {
    const listenerDb = newDb()
    const lTaskDAO = new TaskDAO(listenerDb)
    const lSchedDAO = new ScheduleConfigDAO(listenerDb)
    const { sse: lSse, taskEvents: lEvents } = makeSSECollector()
    const listener = new TaskScheduleStatusListener(lTaskDAO, lSchedDAO, lSse)
    const taskId = "e2e-td-listen-run"
    insertTask(listenerDb, { id: taskId, name: "E2E_TD_listen_run", status: "running" })
    listener.onScheduleTransition({
      schedule_id: "sched-R",
      origin_type: "task",
      origin_id: taskId,
      status: "running" as ScheduleStatus,
    })
    expect(readTaskStatus(listenerDb, taskId).status).toBe("running")
    // Idempotent — already running, no SSE
    expect(lEvents).toHaveLength(0)
    listenerDb.close()
  })

  // ── R-INT: cascade-reap on delete ────────────────────────────────────

  it("DELETE /:id cascade-reaps child schedules (origin_type=task)", async () => {
    const id = insertTask(db, { name: "E2E_TD_reap", status: "ready" })
    // Seed 2 child schedules
    const now = new Date().toISOString()
    for (let i = 0; i < 2; i++) {
      scheduleDAO.insertSchedule({
        id: `e2e-td-reap-${id}-${i}`,
        org: ORG,
        name: `E2E_TD_reap_${i}`,
        cron_expression: null,
        timezone: "UTC",
        job_type: "workflow",
        config: "{}",
        status: "queued",
        origin_type: "task",
        origin_id: id,
        origin_role: i === 0 ? "primary" : "subunit",
        created_at: now,
        updated_at: now,
      } as any)
    }
    const res = await app.request(`/api/tasks/${id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    // DB assert: child schedules soft-deleted (R-INT cascade-reap)
    const remaining = readSchedulesByOrigin(db, id)
    expect(remaining).toHaveLength(0)
  })
})
