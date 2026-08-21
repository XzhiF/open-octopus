// packages/server/src/__tests__/tasks-v3-gates.test.ts
//
// 05 — spec-field `source` flag + confirmation persistence + ready gate (D18).
//
// Verifies (against real better-sqlite3 + applySchema, R1/R3/R5):
//   AC1: POST /:id/spec-field body `source` (default "agent"); source="user"
//        → setSpecNotice records the changed field (@@spec_updated next turn);
//        source="agent" / omitted → notice NOT set (SW-BP4 / AC5 backward-compat).
//   AC2: field=goal_confirmed (boolean) / ac_confirmed (string[]) / decisions
//        (string[]) bindable, persisted into task_spec (ticket-01 schema), and
//        spec_field_update SSE broadcasts as usual.
//   AC3: POST /:id/ready gate (D18): goal empty ∨ ac<1 ∨ goal_confirmed!==true ∨
//        an ac item not in ac_confirmed → 409 + {missing:[]}; all satisfied →
//        draft→ready. Gate applies to v3 tasks (task_type set) only.
//   AC4: confirmation state persists across GET (DB-backed, not UI temp).
//
// Anti-fake-run: real DB + applySchema (R1/R3/R5), Hono app.request (R3 API↔DB),
// data prefix E2E_TD_ (R7), assert response body + SQL + SSE (R4). Only the
// server seam is exercised; the clone-chat delivery of @@spec_updated is
// covered by clone-spec-notice.test.ts (already passing).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import {
  SPEC_FIELD_UPDATE_EVENT,
  TASK_ARTIFACTS_UPDATE_EVENT,
} from "@octopus/shared"
import {
  getSpecNotice,
  clearAllSpecNotices,
} from "../services/tasks/spec-notice-store"

const ORG = "e2e-td-05"

type SpecFieldEvent = { task_id: string; field: string; value: unknown; version: number }
type ArtifactsEvent = { task_id: string }

function makeSSECollector() {
  const sse = new SSEService()
  const specEvents: SpecFieldEvent[] = []
  const artifactEvents: ArtifactsEvent[] = []
  sse.subscribe("taskpool", (e) => {
    if (e.event === SPEC_FIELD_UPDATE_EVENT) {
      specEvents.push(e.data as SpecFieldEvent)
    }
    if (e.event === TASK_ARTIFACTS_UPDATE_EVENT) {
      artifactEvents.push(e.data as ArtifactsEvent)
    }
  })
  return { sse, specEvents, artifactEvents }
}

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

/** Insert a task row directly (bypass the service) to control task_spec state. */
function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string
    name: string
    status: string
    task_spec: Record<string, unknown>
    version: number
  }> = {},
) {
  const id = overrides.id ?? `e2e-td-task-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const spec = overrides.task_spec ?? { goal: "E2E_TD goal", ac: ["E2E_TD ac1"] }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, ?, NULL, ?, ?, NULL)
  `).run(
    id,
    ORG,
    overrides.name ?? "E2E_TD task",
    overrides.status ?? "draft",
    JSON.stringify(spec),
    overrides.version ?? 1,
    now,
    now,
  )
  return id
}

function readTaskSpec(db: Database.Database, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT task_spec, version FROM tasks WHERE id = ?").get(id) as
    { task_spec: string; version: number }
  return { ...JSON.parse(row.task_spec), _version: row.version }
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

describe("05: spec-field source + confirmation persistence + ready gate (integration)", () => {
  let db: Database.Database
  let app: Hono
  let sse: SSEService
  let specEvents: SpecFieldEvent[]
  let artifactEvents: ArtifactsEvent[]
  let taskDAO: TaskDAO

  beforeAll(() => {
    db = newDb()
    const collector = makeSSECollector()
    sse = collector.sse
    specEvents = collector.specEvents
    artifactEvents = collector.artifactEvents
    taskDAO = new TaskDAO(db)
    const service = new TasksService(db, sse, new AgentSessionDAO(db))
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    // Isolate the in-memory notice store + SSE collector between cases.
    clearAllSpecNotices()
    specEvents.length = 0
    artifactEvents.length = 0
  })

  // ── AC1: source flag ───────────────────────────────────────────────────

  it("AC1a: spec-field(goal, source=user) → version+1 ∧ spec notice pending with field name", async () => {
    const id = insertTask(db, { name: "E2E_TD_src_user" })
    expect(getSpecNotice(id)).toBeUndefined()

    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD revised goal", source: "user" }),
    })
    expect(res.status).toBe(200)
    const result = await json<{ version: number }>(res)
    expect(result.version).toBe(2)

    // Notice is pending, keyed by task_id, carrying the @@spec_updated token +
    // the changed field name (the agent reconciles on the next chat turn).
    const notice = getSpecNotice(id)
    expect(notice).toBeDefined()
    expect(notice).toContain("@@spec_updated")
    expect(notice).toContain("goal")
  })

  it("AC1b: spec-field(goal, source=agent) → version+1 ∧ NO spec notice (agent edits don't echo back)", async () => {
    const id = insertTask(db, { name: "E2E_TD_src_agent" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD agent goal", source: "agent" }),
    })
    expect(res.status).toBe(200)
    expect((await json<{ version: number }>(res)).version).toBe(2)
    // SW-BP4: agent source must NOT set a notice, or the agent would see its own
    // edit echoed back as a user override on the next turn.
    expect(getSpecNotice(id)).toBeUndefined()
  })

  it("AC1c/AC5: spec-field(goal, source omitted) → default agent, NO notice (existing callers unchanged)", async () => {
    const id = insertTask(db, { name: "E2E_TD_src_default" })
    // No `source` in body — existing agent curl recipes / E2E helpers behave
    // exactly as before (default agent, no @@spec_updated nudge).
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD default-source goal" }),
    })
    expect(res.status).toBe(200)
    expect((await json<{ version: number }>(res)).version).toBe(2)
    expect(getSpecNotice(id)).toBeUndefined()
  })

  // ── AC2: bindable confirmation + decisions fields ─────────────────────

  it("AC2a: spec-field(goal_confirmed=true) persists into task_spec + emits SSE", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_goal_conf",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal_confirmed", value: true }),
    })
    expect(res.status).toBe(200)
    expect((await json<{ version: number }>(res)).version).toBe(2)
    // DB cross-validation (R3)
    const spec = readTaskSpec(db, id)
    expect(spec.goal_confirmed).toBe(true)
    // SSE broadcast (R3)
    expect(specEvents).toContainEqual({
      task_id: id,
      field: "goal_confirmed",
      value: true,
      version: 2,
    })
  })

  it("D19: every spec-field update also emits companion task_artifacts_update (same taskpool stream, no polling)", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_artifacts_evt",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD updated goal" }),
    })
    expect(res.status).toBe(200)
    // Companion event carries the task id so the OutputViewer can filter + re-fetch.
    expect(artifactEvents).toContainEqual({ task_id: id })
  })

  it("AC2b: spec-field(ac_confirmed=[...]) persists into task_spec + emits SSE", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_ac_conf",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1", "E2E_TD ac2"], task_type: "coding" },
    })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "ac_confirmed", value: ["E2E_TD ac1", "E2E_TD ac2"] }),
    })
    expect(res.status).toBe(200)
    expect((await json<{ version: number }>(res)).version).toBe(2)
    const spec = readTaskSpec(db, id)
    expect(spec.ac_confirmed).toEqual(["E2E_TD ac1", "E2E_TD ac2"])
    expect(specEvents).toContainEqual({
      task_id: id,
      field: "ac_confirmed",
      value: ["E2E_TD ac1", "E2E_TD ac2"],
      version: 2,
    })
  })

  it("AC2c: spec-field(decisions=[...]) persists into task_spec + emits SSE", async () => {
    const id = insertTask(db, { name: "E2E_TD_decisions", task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"] } })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "decisions", value: ["E2E_TD adopt suggestion A"] }),
    })
    expect(res.status).toBe(200)
    expect((await json<{ version: number }>(res)).version).toBe(2)
    const spec = readTaskSpec(db, id)
    expect(spec.decisions).toEqual(["E2E_TD adopt suggestion A"])
    expect(specEvents).toContainEqual({
      task_id: id,
      field: "decisions",
      value: ["E2E_TD adopt suggestion A"],
      version: 2,
    })
  })

  it("AC2d: spec-field(goal_confirmed=<non-boolean>) → 400", async () => {
    const id = insertTask(db, { name: "E2E_TD_bad_gc" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal_confirmed", value: "not-a-bool" }),
    })
    expect(res.status).toBe(400)
  })

  it("AC2e: spec-field(ac_confirmed=[<non-string>]) → 400", async () => {
    const id = insertTask(db, { name: "E2E_TD_bad_ac" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "ac_confirmed", value: [123] }),
    })
    expect(res.status).toBe(400)
  })

  // ── AC3: ready gate (D18) ─────────────────────────────────────────────

  it("AC3a: ready on v3 task with empty goal → 409 + missing contains 'goal'", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_gate_nogoal",
      task_spec: { goal: "", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await json<{ error: string; missing: string[] }>(res)
    expect(body.missing).toContain("goal")
  })

  it("AC3b: ready with goal+ac but no goal_confirmed → 409 + missing contains 'goal_confirmed' & 'ac_confirmed'", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_gate_unconfirmed",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await json<{ error: string; missing: string[] }>(res)
    expect(body.missing).toContain("goal_confirmed")
    expect(body.missing).toContain("ac_confirmed")
    // goal + ac ARE present, so they must NOT be in the missing list
    expect(body.missing).not.toContain("goal")
    expect(body.missing).not.toContain("ac")
  })

  it("AC3c: ready with goal_confirmed=true but ac unconfirmed → 409 + missing contains 'ac_confirmed' only", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_gate_aconly",
      task_spec: {
        goal: "E2E_TD goal",
        ac: ["E2E_TD ac1", "E2E_TD ac2"],
        task_type: "coding",
        goal_confirmed: true,
        // ac_confirmed only covers ac1 — ac2 still unconfirmed
        ac_confirmed: ["E2E_TD ac1"],
      },
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await json<{ error: string; missing: string[] }>(res)
    expect(body.missing).toEqual(["ac_confirmed"])
  })

  it("AC3d: ready with all confirmed → 200 ∧ status=ready", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_gate_pass",
      task_spec: {
        goal: "E2E_TD goal",
        ac: ["E2E_TD ac1"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["E2E_TD ac1"],
      },
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    const task = await json<{ id: string; status: string }>(res)
    expect(task.status).toBe("ready")
    // DB cross-validation (R3)
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }
    expect(row.status).toBe("ready")
  })

  it("AC3e: ready on v2 task (no task_type) with goal+ac but no confirmation → 200 (gate N/A)", async () => {
    // Legacy/v2 tasks predate the v3 confirmation flow; the gate must not
    // reject them (preserves the 22 passing tasks-routes.test.ts ready cases).
    const id = insertTask(db, {
      name: "E2E_TD_v2_no_gate",
      task_spec: { goal: "E2E_TD v2 goal", ac: ["E2E_TD ac1"] },
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    expect((await json<{ status: string }>(res)).status).toBe("ready")
  })

  // ── AC4: confirmation persists across GET ─────────────────────────────

  it("AC4: confirming goal_confirmed/ac_confirmed via spec-field survives a fresh GET (DB-backed, not UI temp)", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_persist",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    // Confirm both gates via spec-field (the user-direct-edit path)
    let res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal_confirmed", value: true, source: "user" }),
    })
    expect(res.status).toBe(200)
    res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "ac_confirmed", value: ["E2E_TD ac1"], source: "user" }),
    })
    expect(res.status).toBe(200)

    // Fresh GET — confirmation fields are still there (would be lost if UI-temp)
    res = await app.request(`/api/tasks/${id}`)
    expect(res.status).toBe(200)
    const detail = await json<{ task_spec: { goal_confirmed?: boolean; ac_confirmed?: string[] } }>(res)
    expect(detail.task_spec.goal_confirmed).toBe(true)
    expect(detail.task_spec.ac_confirmed).toEqual(["E2E_TD ac1"])
  })
})
