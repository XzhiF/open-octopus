// packages/server/src/__tests__/tasks-v3-assist.test.ts
//
// Ticket 07 — 编写期辅助工作流 (assist-workflow) integration verification.
// Covers AC2/AC3/AC4/AC5/AC6/AC7 + the SW-BP10 output-parse fallback.
//
// Real DB (applySchema) + real DAOs + real TaskHomeService (temp home). The
// ExecutionService is mocked (getExecutionService → spy) so the engine doesn't
// really run an LLM — this test asserts the SERVER-side trigger/materialization
// + output parsing, mirroring composite-dispatch.test.ts / tasks-v3-dispatch.
// AC4's log/output reading is exercised by directly inserting node_executions
// rows (the same shape the real engine's onNodeEnd writes) + JSONL log files.
//
// Anti-fake-run: real better-sqlite3 + applySchema (R1/R3/R4), data prefix
// E2E_TD_ (R7), assert response + SQL + filesystem (R3/R4/R5).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { TaskDAO } from "../db/dao/task-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { WorkspaceDAO } from "../db/dao/workspace-dao"
import { SSEService } from "../services/sse"
import { TaskHomeService } from "../services/tasks/task-home-service"
import {
  AssistWorkflowService,
  ASSIST_WORKFLOW_TEMPLATES,
  ASSIST_RUN_UPDATE_EVENT,
  stripCodeFences,
} from "../services/tasks/assist-workflow-service"
import { createTasksRoutes } from "../routes/tasks"
import { TasksService } from "../services/tasks/tasks-service"
import { AgentSessionDAO } from "../db/dao"

const ORG = "e2e-td-07"

// ── Mock getExecutionService (mirrors composite-dispatch.test.ts) ──────
// The engine isn't really run; create/start/registerExternalCallbacks are
// spies so we can assert the trigger materializes the right calls. The
// onComplete callback is captured so AC6's reap can be driven explicitly.
//
// `create` inserts a REAL execution row into the test db (so the service's
// follow-up execDAO.updateExecution(pipeline_config) + findById work) — the
// row mirrors what ExecutionLifecycle.create would persist. `dbRef` is set
// per-test in beforeEach (vi.mock factories can't close over the per-test db).
let dbRef: Database.Database | null = null
const createSpy = vi.fn((_workspaceId: string, _input: unknown) => {
  const id = `exec-assist-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const input = (_input ?? {}) as { workflow_ref?: string }
  dbRef?.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref,
      workflow_name, status, gate_status, rollback, rollback_on_error, input_values,
      var_pool, progress, triggered_by, node_type, branch, org, created_at, updated_at,
      pipeline_config)
    VALUES (?, ?, '0', 0, ?, ?, 'pending', 'closed', 'none', 0, '{}', '{}', 0, 'task-assist', 'normal', NULL, ?, ?, ?, '{}')
  `).run(id, _workspaceId, input.workflow_ref ?? "moa-requirements-review", "assist", ORG, now, now)
  return { id }
})
const startSpy = vi.fn(async () => undefined)
const registeredCallbacks: Array<{ onComplete?: (...args: unknown[]) => void; onError?: (...args: unknown[]) => void; execId?: string }> = []
const registerCallbacksSpy = vi.fn((cbs: { onComplete?: (...a: unknown[]) => void; onError?: (...a: unknown[]) => void }, execId?: string) => {
  registeredCallbacks.push({ ...cbs, execId })
})
const clearCallbacksSpy = vi.fn()
vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: vi.fn(() => ({
    service: {
      create: createSpy,
      start: startSpy,
      registerExternalCallbacks: registerCallbacksSpy,
      clearExternalCallbacks: clearCallbacksSpy,
    },
    wsPath: "/tmp/e2e-td-07-home",
  })),
}))

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  // applySchema re-enables FKs (legacy migration side-effect), so turn them OFF
  // AFTER schema application. The trigger path inserts a real executions row
  // referencing the temp workspace; reaping the workspace row while the
  // execution still references it would otherwise trip FK RESTRICT (mirrors
  // 06-schedules-origin-materialize.test.ts:133 + composite-dispatch.test.ts).
  db.pragma("foreign_keys = OFF")
  return db
}

/** Insert a task row directly with a given task_spec. */
function insertTask(
  db: Database.Database,
  overrides: { id?: string; task_spec?: Record<string, unknown>; project_ids?: string[]; org?: string } = {},
): string {
  const id = overrides.id ?? `e2e-td-task-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', ?, NULL, 1, NULL, ?, ?, NULL)
  `).run(
    id,
    overrides.org ?? ORG,
    "E2E_TD assist task",
    JSON.stringify(overrides.task_spec ?? { goal: "E2E_TD goal: build X", ac: ["E2E_TD ac1"] }),
    JSON.stringify(overrides.project_ids ?? ["E2E_TD_proj"]),
    now,
    now,
  )
  return id
}

/** Insert an execution row + (optionally) a swarm node_execution whose
 *  outputs.synthesis is what getRun parses. Mirrors what the real engine's
 *  onNodeEnd persists (EngineCallbacks.ts:369). */
function insertExecutionWithOutput(
  db: Database.Database,
  opts: {
    id: string
    workspace_id: string
    task_id: string
    template: string
    status?: string
    synthesis?: string
    nodeStatus?: string
  },
): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref,
      workflow_name, status, gate_status, rollback, rollback_on_error, input_values,
      var_pool, progress, triggered_by, node_type, branch, org, created_at, updated_at,
      pipeline_config)
    VALUES (?, ?, '0', 0, ?, ?, ?, 'closed', 'none', 0, '{}', '{}', 0, 'task-assist', 'normal', NULL, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.workspace_id,
    opts.template,
    `assist-${opts.template}`,
    opts.status ?? "completed",
    ORG,
    now,
    now,
    JSON.stringify({ task_id: opts.task_id, template: opts.template }),
  )

  if (opts.synthesis !== undefined) {
    const neId = `${opts.id}-panel`
    db.prepare(`
      INSERT INTO node_executions (id, execution_id, node_id, node_type, status,
        started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs,
        session_id, parent_node_id, iteration_index)
      VALUES (?, ?, 'panel', 'swarm', ?, ?, ?, 10, 0, NULL, NULL, ?, NULL, NULL, NULL)
    `).run(
      neId,
      opts.id,
      opts.nodeStatus ?? "completed",
      now,
      now,
      JSON.stringify({ synthesis: opts.synthesis }),
    )
  }
}

/** Write a JSONL log file for a run (AC4 — logs come from {home}/logs/{execId}/). */
function writeLogLine(home: string, executionId: string, entry: Record<string, unknown>): void {
  const dir = path.join(home, "logs", executionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "panel.jsonl")
  fs.appendFileSync(file, JSON.stringify(entry) + "\n")
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

describe("07: AssistWorkflowService + routes (integration)", () => {
  let db: Database.Database
  let sse: SSEService
  let taskHome: TaskHomeService
  let tmpBase: string
  let assistService: AssistWorkflowService
  let app: Hono
  let execDAO: ExecutionDAO
  let workspaceDAO: WorkspaceDAO

  beforeEach(() => {
    db = newDb()
    dbRef = db
    sse = new SSEService()
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-td-07-"))
    taskHome = new TaskHomeService(tmpBase)
    assistService = new AssistWorkflowService(db, sse, taskHome)
    execDAO = new ExecutionDAO(db)
    workspaceDAO = new WorkspaceDAO(db)

    // Wire routes with the assist service (3rd arg, ticket 07).
    const tasksService = new TasksService(db, sse, new AgentSessionDAO(db))
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(tasksService, sse, assistService))

    // Reset mocks between tests.
    createSpy.mockClear()
    startSpy.mockClear()
    registerCallbacksSpy.mockClear()
    clearCallbacksSpy.mockClear()
    registeredCallbacks.length = 0
  })

  afterEach(() => {
    dbRef = null
    db.close()
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  // ── AC3: trigger legal template → 200; illegal template → 400 ──────────

  it("POST /:id/assist-workflows with legal template → 200 + {run_id, execution_id, workspace_id, template}", async () => {
    const taskId = insertTask(db)
    const res = await app.request(`/api/tasks/${taskId}/assist-workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "moa-requirements-review" }),
    })
    expect(res.status).toBe(200)
    const body = await json<{ run_id: string; execution_id: string; workspace_id: string; template: string }>(res)
    expect(body.template).toBe("moa-requirements-review")
    expect(body.run_id).toBe(body.execution_id) // run_id === execution_id (no new table)
    expect(body.workspace_id).toBeTruthy()
  })

  it("POST /:id/assist-workflows with illegal template → 400", async () => {
    const taskId = insertTask(db)
    const res = await app.request(`/api/tasks/${taskId}/assist-workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "not-a-real-template" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /:id/assist-workflows for missing task → 404", async () => {
    const res = await app.request(`/api/tasks/no-such-task/assist-workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "moa-requirements-review" }),
    })
    expect(res.status).toBe(404)
  })

  // ── AC2: temp workspace (source='task-assist') + pipeline_config ──────

  it("trigger creates a temp workspace with source='task-assist' + path=task home (D16)", async () => {
    const taskId = insertTask(db)
    const body = await assistService.trigger(taskId, "spec-review-swarm")
    // Workspace row (R3/R4 — SQL cross-check).
    const ws = workspaceDAO.findById(body.workspace_id)!
    expect(ws.source).toBe("task-assist")
    expect(ws.path).toBe(taskHome.homePath(taskId))
  })

  it("trigger records {task_id, template} on executions.pipeline_config (AC2)", async () => {
    const taskId = insertTask(db)
    const body = await assistService.trigger(taskId, "clarify-debate")
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)
    // The execution id returned by the mocked create() — pipeline_config written via updateExecution.
    const execId = (createSpy.mock.results[0].value as { id: string }).id
    expect(execId).toBe(body.execution_id)
    const exec = execDAO.findById(execId)!
    const config = JSON.parse(exec.pipeline_config)
    expect(config.task_id).toBe(taskId)
    expect(config.template).toBe("clarify-debate")
  })

  it("trigger passes goal/ac/projects as input_values to ExecutionService.create (AC7)", async () => {
    const taskId = insertTask(db, {
      task_spec: { goal: "E2E_TD goal G", ac: ["E2E_TD ac1", "E2E_TD ac2"] },
      project_ids: ["E2E_TD_proj_a", "E2E_TD_proj_b"],
    })
    await assistService.trigger(taskId, "moa-requirements-review")
    const createArg = createSpy.mock.calls[0][1] as { input_values: Record<string, unknown> }
    expect(createArg.input_values.goal).toBe("E2E_TD goal G")
    // ac joined as bullet list
    expect(createArg.input_values.ac).toContain("E2E_TD ac1")
    expect(createArg.input_values.ac).toContain("E2E_TD ac2")
    expect(createArg.input_values.projects).toContain("E2E_TD_proj_a")
  })

  it("trigger registers an onComplete callback that reaps the temp workspace (AC2/AC6)", async () => {
    const taskId = insertTask(db)
    // Create the home so the "home preserved" assertion is meaningful (trigger
    // does not createHome — that's POST /api/tasks' job, ticket 02).
    taskHome.createHome(taskId)
    const body = await assistService.trigger(taskId, "spec-review-swarm")
    expect(registerCallbacksSpy).toHaveBeenCalledTimes(1)
    // Workspace exists before completion.
    expect(workspaceDAO.findById(body.workspace_id)).not.toBeNull()
    // Simulate the engine firing onComplete.
    const registered = registeredCallbacks[0]
    expect(registered.execId).toBe(body.execution_id)
    registered.onComplete?.({})
    // AC6: temp workspace row reaped.
    expect(workspaceDAO.findById(body.workspace_id)).toBeNull()
    // AC6: home dir preserved (NOT reaped — task home belongs to the task).
    expect(fs.existsSync(taskHome.homePath(taskId))).toBe(true)
  })

  // ── AC4/AC5: getRun output parsing ─────────────────────────────────────

  it("getRun parses valid aggregator JSON into three-part output (AC4/AC5)", async () => {
    const taskId = insertTask(db)
    // Create the temp workspace row (so workspace_id is valid) + execution with synthesis.
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const execId = `exec-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO workspaces (id, name, org, description, status, path, created_at, updated_at, source, source_schedule_id)
      VALUES (?, ?, ?, '', 'active', ?, ?, ?, 'task-assist', NULL)`).run(wsId, `ws-${wsId}`, ORG, taskHome.homePath(taskId), now, now)
    insertExecutionWithOutput(db, {
      id: execId,
      workspace_id: wsId,
      task_id: taskId,
      template: "moa-requirements-review",
      synthesis: '{"ac_candidates":["E2E_TD ac-cand-1"],"suggestions":["E2E_TD sug-1"],"risks":["E2E_TD risk-1"]}',
    })

    const run = assistService.getRun(taskId, execId)
    expect(run.status).toBe("completed")
    expect(run.template).toBe("moa-requirements-review")
    expect(run.output).toBeDefined()
    expect(run.output!.ac_candidates).toContain("E2E_TD ac-cand-1")
    expect(run.output!.suggestions).toContain("E2E_TD sug-1")
    expect(run.output!.risks).toContain("E2E_TD risk-1")
    expect(run.output_parse_error).toBeUndefined()
  })

  it("getRun on broken JSON → output_raw non-empty + output_parse_error=true (SW-BP10, AC5)", async () => {
    const taskId = insertTask(db)
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const execId = `exec-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO workspaces (id, name, org, description, status, path, created_at, updated_at, source, source_schedule_id)
      VALUES (?, ?, ?, '', 'active', ?, ?, ?, 'task-assist', NULL)`).run(wsId, `ws-${wsId}`, ORG, taskHome.homePath(taskId), now, now)
    insertExecutionWithOutput(db, {
      id: execId,
      workspace_id: wsId,
      task_id: taskId,
      template: "moa-requirements-review",
      synthesis: '{broken',
    })

    const run = assistService.getRun(taskId, execId)
    expect(run.output_parse_error).toBe(true)
    expect(run.output_raw).toBe("{broken")
    expect(run.output).toBeUndefined()
  })

  it("getRun tolerates markdown ```json fences around the aggregator output", async () => {
    const taskId = insertTask(db)
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const execId = `exec-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO workspaces (id, name, org, description, status, path, created_at, updated_at, source, source_schedule_id)
      VALUES (?, ?, ?, '', 'active', ?, ?, ?, 'task-assist', NULL)`).run(wsId, `ws-${wsId}`, ORG, taskHome.homePath(taskId), now, now)
    insertExecutionWithOutput(db, {
      id: execId,
      workspace_id: wsId,
      task_id: taskId,
      template: "spec-review-swarm",
      synthesis: '```json\n{"ac_candidates":["E2E_TD a"],"suggestions":[],"risks":[]}\n```',
    })

    const run = assistService.getRun(taskId, execId)
    expect(run.output_parse_error).toBeUndefined()
    expect(run.output!.ac_candidates).toContain("E2E_TD a")
  })

  // ── AC4: logs from JSONL ────────────────────────────────────────────────

  it("getRun surfaces process logs from {home}/logs/{execId}/ (AC4)", async () => {
    const taskId = insertTask(db)
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const execId = `exec-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    // Create home so logs can be written.
    taskHome.createHome(taskId)
    db.prepare(`INSERT INTO workspaces (id, name, org, description, status, path, created_at, updated_at, source, source_schedule_id)
      VALUES (?, ?, ?, '', 'active', ?, ?, ?, 'task-assist', NULL)`).run(wsId, `ws-${wsId}`, ORG, taskHome.homePath(taskId), now, now)
    insertExecutionWithOutput(db, {
      id: execId,
      workspace_id: wsId,
      task_id: taskId,
      template: "moa-requirements-review",
      synthesis: '{"ac_candidates":[],"suggestions":[],"risks":[]}',
    })
    writeLogLine(taskHome.homePath(taskId), execId, { timestamp: "2026-08-18T10:00:00.000Z", nodeId: "panel", event: "swarm_start" })
    writeLogLine(taskHome.homePath(taskId), execId, { timestamp: "2026-08-18T10:00:01.000Z", nodeId: "panel", event: "expert_spawn", role: "需求专家" })
    writeLogLine(taskHome.homePath(taskId), execId, { timestamp: "2026-08-18T10:00:05.000Z", nodeId: "panel", event: "expert_complete", role: "需求专家", status: "completed" })
    writeLogLine(taskHome.homePath(taskId), execId, { timestamp: "2026-08-18T10:00:10.000Z", nodeId: "panel", event: "swarm_complete" })

    const run = assistService.getRun(taskId, execId)
    expect(run.logs.length).toBe(4)
    expect(run.logs[0]).toMatchObject({ icon: "▶", text: "Swarm started" })
    expect(run.logs[1]).toMatchObject({ icon: "•", text: "Expert started: 需求专家" })
    expect(run.logs[2]).toMatchObject({ icon: "✓", text: "Expert completed: 需求专家" })
    expect(run.logs[3]).toMatchObject({ icon: "■", text: "Swarm completed" })
    // Timestamps present (AC4 — 时间戳格式).
    expect(run.logs[0].t).toBe("2026-08-18T10:00:00.000Z")
  })

  // ── Run ownership guard ────────────────────────────────────────────────

  it("GET /:id/assist-workflows/:runId for a run belonging to another task → 403", async () => {
    const taskA = insertTask(db, { id: "e2e-td-task-a" })
    const taskB = insertTask(db, { id: "e2e-td-task-b" })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const execId = `exec-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    taskHome.createHome(taskA)
    db.prepare(`INSERT INTO workspaces (id, name, org, description, status, path, created_at, updated_at, source, source_schedule_id)
      VALUES (?, ?, ?, '', 'active', ?, ?, ?, 'task-assist', NULL)`).run(wsId, `ws-${wsId}`, ORG, taskHome.homePath(taskA), now, now)
    insertExecutionWithOutput(db, { id: execId, workspace_id: wsId, task_id: taskA, template: "moa-requirements-review" })

    // Query under task B → mismatch.
    const res = await app.request(`/api/tasks/${taskB}/assist-workflows/${execId}`)
    expect(res.status).toBe(403)
  })

  it("GET /:id/assist-workflows/:runId for missing run → 404", async () => {
    const taskId = insertTask(db)
    const res = await app.request(`/api/tasks/${taskId}/assist-workflows/no-such-run`)
    expect(res.status).toBe(404)
  })

  // ── SSE: assist_run_update emitted (D19) ───────────────────────────────

  it("trigger emits assist_run_update SSE on the taskpool channel (D19)", async () => {
    const taskId = insertTask(db)
    const events: { event: string; data: unknown }[] = []
    sse.subscribe("taskpool", (e) => events.push({ event: e.event, data: e.data }))
    await assistService.trigger(taskId, "moa-requirements-review")
    const updates = events.filter((e) => e.event === ASSIST_RUN_UPDATE_EVENT)
    expect(updates.length).toBeGreaterThan(0)
    expect((updates[0].data as { task_id: string; phase: string }).task_id).toBe(taskId)
    expect((updates[0].data as { phase: string }).phase).toBe("start")
  })

  // ── Templates whitelist (AC1 — all 3 exist) ────────────────────────────

  it("ASSIST_WORKFLOW_TEMPLATES lists exactly the 3 built-in templates", () => {
    expect(ASSIST_WORKFLOW_TEMPLATES).toEqual([
      "moa-requirements-review",
      "spec-review-swarm",
      "clarify-debate",
    ])
  })

  // ── stripCodeFences pure helper (SW-BP10 sub-contract) ──────────────────

  it("stripCodeFences removes a single outer ```json fence", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}')
  })
})
