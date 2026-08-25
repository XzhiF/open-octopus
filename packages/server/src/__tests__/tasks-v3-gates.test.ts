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
    workflow_ref: string | null
  }> = {},
) {
  const id = overrides.id ?? `e2e-td-task-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const spec = overrides.task_spec ?? { goal: "E2E_TD goal", ac: ["E2E_TD ac1"] }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', ?, ?, NULL, ?, ?, NULL)
  `).run(
    id,
    ORG,
    overrides.name ?? "E2E_TD task",
    overrides.status ?? "draft",
    JSON.stringify(spec),
    overrides.workflow_ref ?? null,
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
    // task-workflow-handoff (ADR-0013): inject a stub BuiltInWorkflowService that
    // recognizes any ref whose group or bare-name matches the e2e-td-* test prefix.
    // This lets the ready-gate resolver find "e2e-td-XX/simple" without touching
    // the real ResourceManager or the filesystem.
    const stubBuiltIn = {
      get(ref: string) {
        // Accept any ref containing an "e2e-td" component (group or name).
        if (ref.includes("e2e-td")) {
          return { ref, content: "stub-builtin" }
        }
        return null
      },
    } as any
    const service = new TasksService(db, sse, new AgentSessionDAO(db), undefined, undefined, stubBuiltIn)
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
      workflow_ref: "e2e-td-04/simple", // satisfy the option-A gate → isolate ac_confirmed
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

  it("AC3d: ready with all confirmed + simple workflow_ref → 200 ∧ status=ready", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_gate_pass",
      workflow_ref: "e2e-td-04/simple", // simple task requires a dispatch workflow_ref
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

  it("AC3f: ready on v3 SIMPLE task with all confirmed but NO workflow_ref → 409 + missing contains 'workflow_ref'", async () => {
    // Option-A gate (2026-08-23): a simple v3 task (subunits < 2) materializes
    // workflow_chain[0].workflow_ref from tasks.workflow_ref; an empty ref fails at
    // runtime ("Workflow not found"), so enqueue must be rejected up-front.
    const id = insertTask(db, {
      name: "E2E_TD_gate_noref",
      task_spec: {
        goal: "E2E_TD goal",
        ac: ["E2E_TD ac1"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["E2E_TD ac1"],
      },
      // workflow_ref omitted → NULL (the helper default) — the gated condition
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await json<{ error: string; missing: string[] }>(res)
    expect(body.missing).toContain("workflow_ref")
    // Everything else IS satisfied → only workflow_ref missing
    expect(body.missing).toEqual(["workflow_ref"])
    // Task stays draft (not a partial flip)
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }
    expect(row.status).toBe("draft")
  })

  it("AC3g: ready on v3 COMPOSITE task (2+ subunits) with no task-level workflow_ref → 200 (built-in composition-task)", async () => {
    // Composite materializes to the built-in 'composition-task' ref, so a
    // task-level workflow_ref is NOT required by the option-A gate.
    const id = insertTask(db, {
      name: "E2E_TD_gate_comp",
      task_spec: {
        goal: "E2E_TD goal",
        ac: ["E2E_TD ac1"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["E2E_TD ac1"],
        subunits: [
          {
            name: "su-a", workspace_spec: { org: ORG, branch_prefix: "aa", projects: [] },
            workflow_ref: "wf-a", input_values: {}, skills: [], resources: [],
          },
          {
            name: "su-b", workspace_spec: { org: ORG, branch_prefix: "bb", projects: [] },
            workflow_ref: "wf-b", input_values: {}, skills: [], resources: [],
          },
        ],
      },
      // workflow_ref (task-level) intentionally NULL — composite doesn't need it
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    expect((await json<{ status: string }>(res)).status).toBe("ready")
  })

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

  // ── task-workflow-handoff (ADR-0013): workflow_ref spec-field bind + view ──

  it("AC7: spec-field(workflow_ref=<resolvable>) → 200 + version bump + SSE + column set", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_wf_bind",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    // Resolvable via stub builtin (matches "e2e-td" substring)
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "workflow_ref", value: "e2e-td/my-flow" }),
    })
    expect(res.status).toBe(200)
    const result = await json<{ version: number }>(res)
    expect(result.version).toBe(2)

    // SSE: spec_field_update carries field="workflow_ref" + value
    const event = specEvents.find((e) => e.task_id === id && e.field === "workflow_ref")
    expect(event).toBeDefined()
    expect(event!.value).toBe("e2e-td/my-flow")

    // DB column set
    const row = db.prepare("SELECT workflow_ref FROM tasks WHERE id = ?").get(id) as { workflow_ref: string | null }
    expect(row.workflow_ref).toBe("e2e-td/my-flow")
  })

  it("AC7: spec-field(workflow_ref=<UNRESOLVABLE>) → 400 + column unchanged", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_wf_reject",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    // Non-resolvable: "unknown/flow" doesn't match the e2e-td-* stub
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "workflow_ref", value: "unknown/flow" }),
    })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toContain("workflow not resolvable")

    // Column remains null
    const row = db.prepare("SELECT workflow_ref FROM tasks WHERE id = ?").get(id) as { workflow_ref: string | null }
    expect(row.workflow_ref).toBeNull()
  })

  it("AC7: spec-field(workflow_ref=<empty>) → 400 (shared validator)", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_wf_empty",
      task_spec: { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
    })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "workflow_ref", value: "" }),
    })
    expect(res.status).toBe(400)
  })

  it("AC9: ready on v3 SIMPLE task with NON-EMPTY but UNRESOLVABLE workflow_ref → 409 + missing contains 'workflow_ref' (S3 gate upgrade)", async () => {
    // S3 gate upgrade: non-empty alone is no longer enough. The ref must be
    // resolvable against the resolution set. A non-empty but unresolvable ref
    // is treated the same as empty.
    const id = insertTask(db, {
      name: "E2E_TD_gate_unresolvable",
      workflow_ref: "unknown/flow", // not in stub builtin; no task-home file
      task_spec: {
        goal: "E2E_TD goal",
        ac: ["E2E_TD ac1"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["E2E_TD ac1"],
      },
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await json<{ error: string; missing: string[] }>(res)
    expect(body.missing).toContain("workflow_ref")
    // Task stays draft
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }
    expect(row.status).toBe("draft")
  })

  // ── GET /:id/workflow-ref (AC8 view endpoint) ─────────────────────────

  it("AC8: GET /workflow-ref on unbound task → {ref,content,source}=null", async () => {
    const id = insertTask(db, { name: "E2E_TD_wf_unbound" })
    const res = await app.request(`/api/tasks/${id}/workflow-ref`)
    expect(res.status).toBe(200)
    const body = await json<{ ref: string | null; content: string | null; source: string | null }>(res)
    expect(body.ref).toBeNull()
    expect(body.content).toBeNull()
    expect(body.source).toBeNull()
  })

  it("AC8: GET /workflow-ref on bound (resolvable) task → {ref,content,source}", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_wf_bound",
      workflow_ref: "e2e-td/my-flow",
    })
    const res = await app.request(`/api/tasks/${id}/workflow-ref`)
    expect(res.status).toBe(200)
    const body = await json<{ ref: string; content: string; source: string }>(res)
    expect(body.ref).toBe("e2e-td/my-flow")
    expect(body.content).toBe("stub-builtin")
    expect(body.source).toBe("builtin")
  })

  it("AC8: GET /workflow-ref on bound but unresolvable ref → 400", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_wf_stale",
      workflow_ref: "unknown/stale",
    })
    const res = await app.request(`/api/tasks/${id}/workflow-ref`)
    expect(res.status).toBe(400)
  })

  it("AC8: GET /workflow-ref on missing task → 404", async () => {
    const res = await app.request("/api/tasks/no-such-id/workflow-ref")
    expect(res.status).toBe(404)
  })
})
