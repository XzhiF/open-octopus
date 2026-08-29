// packages/server/src/__tests__/tasks-trigger-mutex.test.ts
//
// v39 任务看板调度重构 — 人工触发 / 单次定时 / 同任务互斥。
//
// Verifies:
//   1. enqueue parks: readyTask creates a DRAFT envelope (not auto-runnable)
//   2. immediate trigger: draft→queued + due≈now + task running + SSE + wake
//   3. one-shot time trigger: future due NOT claimed until due; FIFO by due
//   4. same-task mutex (structural): ready-only + draft-only-arm + one active
//      instance per schedule (partial unique index) — a running/queued task
//      cannot be re-armed; DIFFERENT tasks claim concurrently (cap applies).
//   5. cancel withdraws a future trigger back to parked ready
//   6. routes: zod 400 on bad `at`; trigger/cancel end-to-end
//   7. list enrichment: schedule_status / scheduled_at on the DTO
//   8. wake(): sub-second claim pass + no-op when stopped
//
// Anti-fake-run: real better-sqlite3 + applySchema, Hono requests, cross-check
// response ↔ DB, E2E_TTM_ prefix.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { ScheduleConfigDAO, ScheduleRunDAO, AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService, TaskStatusConflictError } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { SchedulerEngine } from "../services/scheduler/scheduler-engine"
import type { Executor } from "../services/scheduler/executors/executor-interface"
import { TASK_STATUS_EVENT, TASK_TRIGGER_EVENT } from "@octopus/shared"

const ORG = "e2e-ttm"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare(
    "INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))",
  ).run()
  return db
}

function makeTaskRow(db: Database.Database, overrides: Partial<{ id: string; status: string }> = {}): string {
  const id = overrides.id ?? `e2e-ttm-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
  `).run(id, ORG, `E2E_TTM ${id}`, overrides.status ?? "draft", JSON.stringify({ goal: "g", ac: ["a"] }), now, now)
  return id
}

/** Insert a task-root schedule directly (bypass the dispatch seam). */
function insertRootSchedule(
  db: Database.Database,
  opts: { taskId: string; role?: string; status: string; scheduledAt?: string | null },
): string {
  const id = `e2e-ttm-sched-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled,
      job_type, config, parallel_policy, status, origin_type, origin_id, origin_role,
      scheduled_at, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'UTC', 1, 'workflow', ?, 'skip', ?, 'task', ?, ?, ?, ?, ?)
  `).run(
    id, ORG, `task-${opts.taskId}-${opts.role ?? "primary"}`,
    JSON.stringify({ type: "workflow", workspace_spec: { org: ORG, branch_prefix: "p", projects: [] }, workflow_chain: [{ workflow_ref: "w", input_values: {} }] }),
    opts.status, opts.taskId, opts.role ?? "primary",
    opts.scheduledAt ?? null, now, now,
  )
  return id
}

function schedRow(db: Database.Database, id: string) {
  return db.prepare("SELECT status, scheduled_at, claimed_at FROM schedules WHERE id = ?").get(id) as
    { status: string; scheduled_at: string | null; claimed_at: string | null }
}

function taskRow(db: Database.Database, id: string) {
  return db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }
}

/** An executor that PENDINGs forever — keeps the schedule in 'claimed' so
 *  same-task-holder setup stays stable during assertions. */
function pendingExecutor(): Executor {
  return {
    getType: () => "workflow",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: vi.fn(() => new Promise<any>(() => {})) as any,
  }
}

function makeEngine(db: Database.Database, executor: Executor) {
  const executors = new Map<string, Executor>()
  executors.set("workflow", executor)
  return new SchedulerEngine(
    new ScheduleConfigDAO(db),
    new ScheduleRunDAO(db),
    { setOnScheduleChange: vi.fn(), trigger: vi.fn() } as never,
    executors,
  )
}

async function runCheck(db: Database.Database) {
  const engine = makeEngine(db, pendingExecutor())
  await (engine as unknown as { checkQueuedTasks(): Promise<void> }).checkQueuedTasks()
}

describe("v39: manual/time trigger + same-task mutex", () => {
  let db: Database.Database
  let sse: SSEService
  let service: TasksService
  let wakes: number

  beforeEach(() => {
    db = newDb()
    sse = new SSEService()
    service = new TasksService(db, sse, new AgentSessionDAO(db))
    wakes = 0
    service.setWakeScheduler(() => { wakes += 1 })
  })

  afterEach(() => {
    db.close()
  })

  // ── 1. enqueue parks ──────────────────────────────────────────────
  it("readyTask parks the envelope (draft) — nothing is auto-claimable", () => {
    const id = makeTaskRow(db)
    service.readyTask(id)
    const root = db.prepare(
      "SELECT id, status, scheduled_at FROM schedules WHERE origin_id = ? AND origin_role='primary'",
    ).get(id) as { id: string; status: string; scheduled_at: string | null }
    expect(root.status).toBe("draft")
    expect(root.scheduled_at).toBeNull()
    expect(taskRow(db, id).status).toBe("ready")
    // poller due-query must not see a parked row (claim-ineligible by status)
    const due = new ScheduleConfigDAO(db).findQueuedSchedules(new Date().toISOString())
    expect(due.find((r) => r.id === root.id)).toBeUndefined()
  })

  // ── 2. immediate trigger ──────────────────────────────────────────
  it("triggerTask(immediate) arms draft→queued + mirrors running + SSE + wake", () => {
    const events: Array<{ event: string; data: unknown }> = []
    sse.subscribe("taskpool", (e) => events.push(e))
    const id = makeTaskRow(db)
    service.readyTask(id)
    const before = Date.now()

    const dto = service.triggerTask(id)
    expect(dto.status).toBe("running")
    const root = db.prepare("SELECT status, scheduled_at FROM schedules WHERE origin_id=? AND origin_role='primary'").get(id) as { status: string; scheduled_at: string | null }
    expect(root.status).toBe("queued")
    expect(new Date(root.scheduled_at!).getTime() - before).toBeLessThan(5000)
    expect(taskRow(db, id).status).toBe("running")
    expect(wakes).toBe(1)
    const triggerEv = events.find((e) => e.event === TASK_TRIGGER_EVENT)
    expect(triggerEv).toBeTruthy()
    expect((triggerEv!.data as { action: string; scheduled_at: string | null }).action).toBe("triggered")
    expect(events.some((e) => e.event === TASK_STATUS_EVENT && (e.data as { status: string }).status === "running")).toBe(true)
  })

  // ── 4. same-task mutex (structural) ───────────────────────────────
  it("same task cannot be re-armed: draft / queued / running each reject a 2nd trigger", () => {
    const id = makeTaskRow(db)
    expect(() => service.triggerTask(id)).toThrow(TaskStatusConflictError) // draft — not ready
    service.readyTask(id)
    service.triggerTask(id) // arms (task mirrors → running)
    // 2nd trigger hits the ready-only gate (same-task single instance)
    expect(() => service.triggerTask(id)).toThrow(TaskStatusConflictError)
    // queued envelope row itself also refuses re-arm (draft-only guard)
    db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(id)
    expect(() => service.triggerTask(id)).toThrow(/排队状态/)
    // simulate claim (poller won) — trigger still refused, task status running anyway
    db.prepare("UPDATE schedules SET status='claimed', claimed_at=? WHERE origin_id=? AND origin_role='primary'")
      .run(new Date().toISOString(), id)
    expect(() => service.triggerTask(id)).toThrow(TaskStatusConflictError)
  })

  it("a task cannot be re-enqueued while an instance is in flight (readyTask is draft-only)", () => {
    const id = makeTaskRow(db)
    service.readyTask(id)
    expect(() => service.readyTask(id)).toThrow(/only draft→ready/)
  })

  it("different tasks claim concurrently (no global lock)", async () => {
    const a = makeTaskRow(db)
    const b = makeTaskRow(db)
    service.readyTask(a)
    service.readyTask(b)
    service.triggerTask(a)
    service.triggerTask(b)
    await runCheck(db)
    const sa = db.prepare("SELECT status FROM schedules WHERE origin_id=? AND origin_role='primary'").get(a) as { status: string }
    const sb = db.prepare("SELECT status FROM schedules WHERE origin_id=? AND origin_role='primary'").get(b) as { status: string }
    expect(sa.status).toBe("claimed")
    expect(sb.status).toBe("claimed")
  })

  // ── 3. due-filter + FIFO ──────────────────────────────────────────
  it("poller: future rows unclaimed until due; due rows claimed FIFO", async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    const t1 = makeTaskRow(db)
    const t2 = makeTaskRow(db)
    const s1 = insertRootSchedule(db, { taskId: t1, status: "queued", scheduledAt: past })
    const s2 = insertRootSchedule(db, { taskId: t2, status: "queued", scheduledAt: future })

    await runCheck(db)
    expect(schedRow(db, s1).status).toBe("claimed") // due → claimed
    expect(schedRow(db, s2).status).toBe("queued")  // not due → stays

    // now make s2 due → next pass claims it (single source of truth = scheduled_at)
    db.prepare("UPDATE schedules SET scheduled_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), s2)
    await runCheck(db)
    expect(schedRow(db, s2).status).toBe("claimed")
  })

  it("subunit children claim on their own schedule rows (composite tree unaffected)", async () => {
    const parent = makeTaskRow(db)
    insertRootSchedule(db, { taskId: parent, role: "coordinator", status: "running" })
    const child = insertRootSchedule(db, { taskId: parent, role: "subunit", status: "queued" })
    await runCheck(db)
    expect(schedRow(db, child).status).toBe("claimed")
  })

  // ── 5. cancel ─────────────────────────────────────────────────────
  it("cancelTaskTrigger withdraws a future trigger back to parked ready", () => {
    const events: string[] = []
    sse.subscribe("taskpool", (e) => { if (e.event === TASK_TRIGGER_EVENT) events.push((e.data as { action: string }).action) })
    const id = makeTaskRow(db)
    service.readyTask(id)
    service.triggerTask(id, new Date(Date.now() + 300_000).toISOString())
    const dto = service.cancelTaskTrigger(id)
    expect(dto.status).toBe("ready")
    const root = db.prepare("SELECT status, scheduled_at FROM schedules WHERE origin_id=? AND origin_role='primary'").get(id) as { status: string; scheduled_at: string | null }
    expect(root.status).toBe("draft")
    expect(root.scheduled_at).toBeNull()
    expect(events).toEqual(["scheduled", "cancelled"])
  })

  it("cancel of an already-claimed trigger → conflict (server-side race guard)", () => {
    const id = makeTaskRow(db)
    service.readyTask(id)
    service.triggerTask(id, new Date(Date.now() + 300_000).toISOString())
    db.prepare("UPDATE schedules SET status='claimed', claimed_at=? WHERE origin_id=? AND origin_role='primary'")
      .run(new Date().toISOString(), id)
    expect(() => service.cancelTaskTrigger(id)).toThrow(TaskStatusConflictError)
  })

  it("cancel of a due-but-unclaimed trigger → conflict (only future is cancellable)", () => {
    const id = makeTaskRow(db)
    service.readyTask(id)
    service.triggerTask(id, new Date(Date.now() + 300_000).toISOString())
    // slip past the due instant while the poller hasn't ticked
    db.prepare("UPDATE schedules SET scheduled_at = ? WHERE origin_id=? AND origin_role='primary'")
      .run(new Date(Date.now() - 5000).toISOString(), id)
    expect(() => service.cancelTaskTrigger(id)).toThrow(TaskStatusConflictError)
  })

  // ── 6+7. routes ───────────────────────────────────────────────────
  describe("routes", () => {
    let app: Hono

    beforeEach(() => {
      app = new Hono()
      app.route("/api/tasks", createTasksRoutes(service, sse))
    })

    it("POST /:id/trigger — bad `at` → 400; armed future → 200", async () => {
      const id = makeTaskRow(db)
      service.readyTask(id)
      const bad = await app.request(`/api/tasks/${id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: "tomorrow-ish" }),
      })
      expect(bad.status).toBe(400)
      const ok = await app.request(`/api/tasks/${id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString() }),
      })
      expect(ok.status).toBe(200)
      const dto = await ok.json()
      expect(dto.status).toBe("running")
    })

    it("POST /:id/trigger — non-ready task → 409 with server message", async () => {
      const id = makeTaskRow(db)
      const res = await app.request(`/api/tasks/${id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/ready/)
    })

    it("POST /:id/trigger/cancel — arms then cancels via API", async () => {
      const id = makeTaskRow(db)
      service.readyTask(id)
      await app.request(`/api/tasks/${id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString() }),
      })
      const res = await app.request(`/api/tasks/${id}/trigger/cancel`, { method: "POST" })
      expect(res.status).toBe(200)
      const dto = await res.json()
      expect(dto.status).toBe("ready")
    })

    it("GET /api/tasks carries schedule_status + scheduled_at (root enrichment)", async () => {
      const id = makeTaskRow(db)
      service.readyTask(id)
      const future = new Date(Date.now() + 300_000).toISOString()
      service.triggerTask(id, future)
      const res = await app.request("/api/tasks")
      const { items } = await res.json()
      const dto = items.find((t: { id: string }) => t.id === id)
      expect(dto.schedule_status).toBe("queued")
      expect(dto.scheduled_at).toBe(future)
    })

    it("trigger survives a fresh service instance (restart = pure DB state)", () => {
      const id = makeTaskRow(db)
      service.readyTask(id)
      const revived = new TasksService(db, sse)
      revived.setWakeScheduler(() => {})
      const future = new Date(Date.now() + 300_000).toISOString()
      const dto = revived.triggerTask(id, future)
      expect(dto.status).toBe("running")
    })
  })

  // ── 8. wake ───────────────────────────────────────────────────────
  it("wake() claims immediately when running; no-op when stopped", async () => {
    const t = makeTaskRow(db)
    const s = insertRootSchedule(db, { taskId: t, status: "queued", scheduledAt: new Date().toISOString() })

    const stopped = makeEngine(db, pendingExecutor())
    stopped.wake() // not started → no-op
    await new Promise((r) => setImmediate(r))
    expect(schedRow(db, s).status).toBe("queued")

    const engine = makeEngine(db, pendingExecutor())
    engine.start()
    engine.wake() // sub-second claim pass
    await new Promise((r) => setImmediate(r))
    expect(schedRow(db, s).status).toBe("claimed")
    engine.stop()
  })
})
